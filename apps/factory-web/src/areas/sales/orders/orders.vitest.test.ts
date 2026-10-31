import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SDI_NEXT_ACTIONS as DOMAIN_SDI_ACTIONS, SDI_STATE_CODES as DOMAIN_SDI_CODES } from '@nexus/factory-domain/invoicing/sdi/words'
import { INVOICE_DOC_TYPES as DOMAIN_DOC_TYPES, INVOICE_STATUSES as DOMAIN_INVOICE_STATUSES } from '@nexus/factory-domain/invoicing/invoices'
import { LINK_STATES as DOMAIN_LINK_STATES } from '@nexus/factory-domain/links/purposes'
import { BOARD_LANES as DOMAIN_LANES, ORDER_ACTIONS as DOMAIN_ACTIONS, SALES_ORDER_STATUSES as DOMAIN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { CLOSE_SHORT_STATUSES as DOMAIN_CLOSE_SHORT, DAILY_ORDER_ACTIONS as DOMAIN_DAILY, IMPACT_CODES as DOMAIN_IMPACT, REOPEN_STATUSES as DOMAIN_REOPEN } from '@nexus/factory-domain/sales/orders/daily'
import { MILESTONE_KINDS as DOMAIN_MILESTONES, MILESTONE_STATUSES as DOMAIN_MILESTONE_STATUSES } from '@nexus/factory-domain/sales/orders/schedule'
import { AMEND_STATUSES as DOMAIN_AMEND, LINE_CHANGES as DOMAIN_LINE_CHANGES } from '@nexus/factory-domain/sales/amendments/amendments'
import { ApiError } from '../../../lib/api/errors'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress as pageOfList, recordAddress, RECORD_PAGES } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { BOARD_LANES, DEPOSIT_KINDS, DEPOSIT_REQUEST_STATUSES, DEPOSIT_STATES, INVOICE_DOC_TYPES, INVOICE_STATUSES, LINK_STATES, ORDER_ACTIONS, ORDER_STATUSES, SDI_NEXT_ACTIONS, SDI_STATE_CODES, SETTLEMENT_GAPS, SHIPMENT_STATUSES, WORK_ORDER_STATUSES } from './api'
import { AMEND_PREVIEW, AMENDMENTS, BOARD, BRN, CANCEL_BLOCKED, CANCEL_CHECK, canOf, deposit, LIST_ROWS, MANUAL_PREVIEW, order, PAID, PARTY, SCHEDULE, SENT_LINK, STYLE, STYLE_ID, TD02, TODAY } from './_demo/fixtures'
import { DAILY_ORDER_ACTIONS, IMPACT_CODES, LINE_CHANGES, MILESTONE_KINDS, MILESTONE_STATUSES, type Milestone } from './api'
import { stepVerbs, waiveHeld, waiveReasonProblem, waiveVerbOf } from './record/schedule/model'
import {
  AMEND_STATUSES,
  amendHeld,
  amendLines,
  cancelConfirmHeld,
  changeCount,
  changeLabel,
  CLOSE_SHORT_STATUSES,
  closableLines,
  closeChoiceProblem,
  closeLinesHeld,
  compareRows,
  copyHeld,
  draftGrid,
  draftOf,
  impactWords,
  isOverdue,
  issueWords,
  manualLines,
  minimumsOf,
  moneyChange,
  newKey,
  REOPEN_STATUSES,
  reopenHeld,
  reviewHeld,
  sizesText,
  underWorkOrders,
  withCells,
  type DraftLine,
} from './daily-model'
import { confirmHeld, draftKey, headerFromAddress, manualBody, newOrderAddress, newOrderHeld, parseDraft, previewByKey } from './new/new-model'
import { designScreen as changesScreen } from './record/changes/fixtures'
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
  it('B-W2a-50: daily actions, impact codes, schedule steps and states, line changes, the states that amend, close and reopen', () => {
    expect([...DAILY_ORDER_ACTIONS]).toEqual([...DOMAIN_DAILY])
    expect([...IMPACT_CODES]).toEqual([...DOMAIN_IMPACT])
    expect([...MILESTONE_KINDS]).toEqual([...DOMAIN_MILESTONES])
    expect([...MILESTONE_STATUSES]).toEqual([...DOMAIN_MILESTONE_STATUSES])
    expect([...LINE_CHANGES]).toEqual([...DOMAIN_LINE_CHANGES])
    expect([...AMEND_STATUSES]).toEqual([...DOMAIN_AMEND])
    expect([...CLOSE_SHORT_STATUSES]).toEqual([...DOMAIN_CLOSE_SHORT])
    expect([...REOPEN_STATUSES]).toEqual([...DOMAIN_REOPEN])
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
    // B-W2b-16: a typed order's deposit (no quote) has its page too.
    expect(linkHeld(deposit({ quoteVersionId: null }), canOf('finance'))).toBeNull()
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
  /\b(?:common|live|status|deposit|depositKind|requestStatus|rows|tile|layout|list|col|bulk|csv|board|tab|step|action|record|held|summary|chain|gate|lines|layer|dates|production|woStatus|ship|shipStatus|money|docType|invoiceStatus|sdi|link|payment|sdiSend|promise|ready|close|settlement|docs|part|notice|stepUp|problem|keys|amend|editor|issue|impact|cancel|closeLines|reopen|copy|schedule|changes|compare|newOrder|grid)\.[a-zA-Z]+(?:\.[a-zA-Z_]+)*\b/
// Permission and grain names are never on screen either; a file name or an e-mail address is not a key.
const NOT_KEYS = /\b[\w.-]+@[\w.-]+\.\w+\b|\b[\w-]+\.(?:pdf|csv)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, recordScreen, changesScreen] as unknown as DesignScreen<unknown>[]) {
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
      // B-W2a-50
      has('tab.changes')
      for (const kind of MILESTONE_KINDS) for (const part of ['kind', 'when']) has(`schedule.${part}.${kind}`)
      for (const status of MILESTONE_STATUSES) has(`schedule.status.${status}`)
      for (const change of LINE_CHANGES) has(`changes.kind.${change}`)
      for (const change of LINE_CHANGES) expect(t(`changes.count.${change}`, { count: 2 }), `${locale}: changes.count.${change}`).not.toBe(`changes.count.${change}`)
      for (const need of ['NEEDED', 'NOT_NEEDED']) has(`changes.reaccept.${need}`)
      for (const change of ['added', 'removed', 'changed', 'none', 'empty']) has(`editor.change.${change}`)
      for (const mode of ['amend', 'new']) has(`editor.empty.${mode}`)
      for (const field of ['customerRef', 'requestedDate']) has(`amend.field.${field}`)
      for (const status of ['PROSPECT', 'ACTIVE', 'BLOCKED', 'ARCHIVED']) has(`newOrder.partyStatus.${status}`)
      for (const mode of ['IT_B2B', 'IT_B2C', 'EU_B2B', 'EU_B2C', 'EXTRA_EU']) has(`newOrder.taxModes.${mode}`)
      for (const state of ['missing', 'error']) has(`newOrder.state.${state}.title`)
      // Every impact code, every refusal place: words exist (never the API's English).
      for (const code of IMPACT_CODES) {
        const words = impactWords({ code, message: 'x', refs: [{ type: 'WorkOrder', id: 'w', number: 'WO-1' }], amount: null }, CANCEL_CHECK)
        expect(t(words.key, words.params), `${locale}: ${words.key}`).not.toBe(words.key)
      }
      for (const path of ['body', 'body/reason', 'body/lines', 'body/partyId', 'body/contactId', 'body/billToAddressId', 'body/shipToAddressId', 'body/promiseDate', 'body/requestedDate', 'body/customerRef', 'body/depositPct', 'body/companyId', 'body/paymentTermsId', 'body/internalNote', 'body/somethingNew', 'body/lines/0/sizes', 'body/lines/0/sizes/2/quantity', 'body/lines/1/unitPrice', 'body/lines/0/colourwayId', 'body/lines/0/styleId', 'body/lines/0/id', 'body/lines/0/note', 'body/lines/0/zzz']) {
        const words = issueWords({ path, message: 'English' }, () => 'X')
        expect(t(words.key, words.params), `${locale}: ${path}`).not.toBe(words.key)
      }
    }
  })
})

// ---- B-W2a-50: the order every day --------------------------------------------------------------------------------------

const lineOf = (value: ReturnType<typeof order>, seq: number) => value.lines.find((line) => line.seq === seq)!

describe('the band’s daily verbs, held with this app’s words', () => {
  it('Amend: sales may while nothing shipped; finance may not; shipped lines are fixed', () => {
    expect(amendHeld(order('CONFIRMED'), canOf('sales'))).toBeNull()
    expect(amendHeld(order('IN_PRODUCTION'), canOf('sales'))).toBeNull()
    expect(amendHeld(order('CONFIRMED'), canOf('finance'))?.key).toBe('held.noManage')
    expect(amendHeld(order('PARTLY_SHIPPED'), canOf('sales'))?.key).toBe('held.amendShipped')
    expect(amendHeld(order('CANCELLED'), canOf('sales'))?.key).toBe('held.final')
  })
  it('Close remaining lines: what is left of open lines; never the only open line of an order that shipped nothing', () => {
    const partly = order('PARTLY_SHIPPED')
    expect(closableLines(partly).map((entry) => [entry.line.seq, entry.left])).toEqual([
      [10, 4],
      [20, 3],
    ])
    expect(closableLines(partly)[0]!.sizes).toEqual([
      { size: '48', left: 1 },
      { size: '50', left: 1 },
      { size: '52', left: 1 },
      { size: '54', left: 1 },
    ])
    expect(closeLinesHeld(partly, canOf('sales'))).toBeNull()
    expect(closeLinesHeld(order('SHIPPED'), canOf('sales'))?.key).toBe('held.closeLinesState')
    const single = order('CONFIRMED', { lines: [lineOf(order('CONFIRMED'), 10)] })
    expect(closeLinesHeld(single, canOf('sales'))?.key).toBe('held.closeLinesOnly')
    expect(closeChoiceProblem(order('CONFIRMED'), [], 'x')?.key).toBe('closeLines.problem.none')
    expect(closeChoiceProblem(order('CONFIRMED'), order('CONFIRMED').lines.map((line) => line.id), 'x')?.key).toBe('closeLines.problem.all')
    expect(closeChoiceProblem(partly, partly.lines.map((line) => line.id), ' ')?.key).toBe('closeLines.problem.reason')
    expect(closeChoiceProblem(partly, partly.lines.map((line) => line.id), 'non vuole il resto')).toBeNull()
  })
  it('Reopen: only closed lines, not on a final order; Copy as quote needs quotes.manage', () => {
    const value = order('PARTLY_SHIPPED')
    expect(reopenHeld(value, canOf('sales'))?.key).toBe('held.reopenNone')
    const closed = { ...value, lines: value.lines.map((line) => (line.seq === 20 ? { ...line, closedShort: { quantity: 2, at: null, byId: null, reason: 'x', reasonCode: null } } : line)) }
    expect(reopenHeld(closed, canOf('sales'))).toBeNull()
    expect(reopenHeld({ ...closed, status: 'CLOSED' }, canOf('sales'))?.key).toBe('held.reopenState')
    expect(copyHeld(canOf('sales'))).toBeNull()
    expect(copyHeld(canOf('finance'))?.key).toBe('held.noQuotes')
  })
})

describe('the amendment draft: what it sends, what it changes, why Review waits', () => {
  const value = order('CONFIRMED')
  it('starts as the order: nothing changes, nothing to review', () => {
    const draft = draftOf(value)
    expect(draft.map((line) => [line.key, line.price, line.locked])).toEqual([
      [lineOf(value, 10).id, '450', false],
      [lineOf(value, 20).id, '440', false],
    ])
    expect(changeCount(draft, value)).toBe(0)
    expect(reviewHeld(draft, value, minimumsOf(value), { changed: false })?.key).toBe('amend.held.nothing')
    expect(reviewHeld(draft, value, minimumsOf(value), { changed: true })).toBeNull()
  })
  it('a size changed, a colour added, a line removed: every kept line whole, the new line with its pieces', () => {
    const black = lineOf(value, 10)
    const red = lineOf(value, 20)
    const draft: DraftLine[] = [
      ...withCells(draftOf(value), { [black.id]: { '48': 2, '50': 3, '52': 3, '54': 2 }, [red.id]: { '50': 0, '52': 0, '54': 0 } }),
      { key: newKey(STYLE_ID, BRN.id), lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2 }, price: '', locked: false },
    ]
    expect(amendLines(draft, value)).toEqual([
      { id: black.id, sizes: [{ size: '48', quantity: 2 }, { size: '50', quantity: 3 }, { size: '52', quantity: 3 }, { size: '54', quantity: 2 }] },
      { styleId: STYLE_ID, colourwayId: BRN.id, sizes: [{ size: '50', quantity: 2 }] },
    ])
    expect(changeCount(draft, value)).toBe(3)
    // A price typed differently is sent; the same price is not; one that is not a price holds Review.
    const priced = draft.map((line) => (line.lineId === black.id ? { ...line, price: '460' } : line))
    expect(amendLines(priced, value)[0]).toMatchObject({ unitPrice: '460' })
    expect(amendLines(draft.map((line) => (line.lineId === black.id ? { ...line, price: '450.00' } : line)), value)[0]).not.toHaveProperty('unitPrice')
    expect(reviewHeld(draft.map((line) => (line.lineId === black.id ? { ...line, price: '4,5,0' } : line)), value, {}, { changed: false })?.key).toBe('amend.held.price')
    // Every line at 0: an order keeps at least one line.
    expect(reviewHeld(withCells(draftOf(value), { [black.id]: {}, [red.id]: {} }), value, {}, { changed: false })?.key).toBe('amend.held.empty')
  })
  it('never under what work orders make: the cell says so and Review waits', () => {
    const production = order('IN_PRODUCTION')
    const black = lineOf(production, 10)
    const draft = withCells(draftOf(production), { [black.id]: { '48': 1, '50': 2, '52': 2, '54': 2 } })
    expect(underWorkOrders(draft, minimumsOf(production))).toEqual([{ key: black.id, size: '48', made: 2 }])
    expect(reviewHeld(draft, production, minimumsOf(production), { changed: false })?.key).toBe('amend.held.workOrders')
  })
  it('a closed-short line stays as it is (sent by id only) and is not in the grid', () => {
    const partly = order('IN_PRODUCTION')
    const closed = { ...partly, lines: partly.lines.map((line) => (line.seq === 20 ? { ...line, closedShort: { quantity: 2, at: null, byId: null, reason: null, reasonCode: null } } : line)) }
    const draft = draftOf(closed)
    expect(draft.find((line) => line.lineId === lineOf(closed, 20).id)?.locked).toBe(true)
    expect(amendLines(draft, closed)).toContainEqual({ id: lineOf(closed, 20).id })
    expect(draftGrid(draft, STYLE, closed).colours.map((colour) => colour.key)).toEqual([lineOf(closed, 10).id])
  })
  it('the grid: the style’s sizes; a colour’s offered sizes plus what the line holds', () => {
    const grid = draftGrid([{ key: 'k', lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '56': 1 }, price: '', locked: false }], STYLE, null)
    expect(grid.sizes.map((size) => size.key)).toEqual(['46', '48', '50', '52', '54', '56'])
    expect(grid.colours[0]!.offered).toEqual(['48', '50', '52', '54', '56'])
  })
})

describe('the API’s refusals by place, in this app’s words (never its English)', () => {
  it('names the line the body sent at that index; header places by field', () => {
    expect(issueWords({ path: 'body/lines/1/unitPrice', message: 'No price list…' }, (index) => (index === 1 ? 'DEMO-JKT-01 · BRN' : null))).toEqual({ key: 'issue.line.price', params: { line: 'DEMO-JKT-01 · BRN' } })
    expect(issueWords({ path: 'body/lines/0/sizes/2/quantity', message: 'x' }, () => null)).toEqual({ key: 'issue.line.sizes', params: { line: '1' } })
    expect(issueWords({ path: 'body/shipToAddressId', message: 'x' }, () => null).key).toBe('issue.shipTo')
    expect(issueWords({ path: 'body', message: 'x' }, () => null).key).toBe('issue.state')
    expect(issueWords({ path: 'body/brandNew', message: 'x' }, () => null).key).toBe('issue.other')
  })
})

describe('Cancel order: the impact in words, the typed number', () => {
  it('counts, numbers and the leather cut; the amount travels beside the words', () => {
    expect(impactWords(CANCEL_CHECK.impact.leavesBehind[1]!, CANCEL_CHECK)).toEqual({ key: 'impact.LEATHER_CUT', params: { count: 3, refs: 'WO-00021' } })
    expect(impactWords(CANCEL_CHECK.impact.leavesBehind[0]!, CANCEL_CHECK)).toEqual({ key: 'impact.WORK_ORDERS_OPEN', params: { refs: 'WO-00021, WO-00022', count: 2 } })
    expect(impactWords(CANCEL_CHECK.impact.leavesBehind[3]!, CANCEL_CHECK)).toEqual({ key: 'impact.DEPOSIT_PAID_invoiced', params: { refs: TD02.number } })
    expect(impactWords({ code: 'STATE', message: 'x', refs: [], amount: null }, { ...CANCEL_CHECK, status: 'CLOSED' }).key).toBe('impact.STATE_final')
  })
  it('held while reading, blocked, without a reason or the exact number', () => {
    expect(cancelConfirmHeld({ check: null, reason: 'x', typed: 'SO-2026-0088', number: 'SO-2026-0088' })?.key).toBe('cancel.held.reading')
    expect(cancelConfirmHeld({ check: CANCEL_BLOCKED, reason: 'x', typed: 'SO-2026-0088', number: 'SO-2026-0088' })?.key).toBe('cancel.held.blocked')
    expect(cancelConfirmHeld({ check: CANCEL_CHECK, reason: ' ', typed: 'SO-2026-0088', number: 'SO-2026-0088' })?.key).toBe('cancel.held.reason')
    expect(cancelConfirmHeld({ check: CANCEL_CHECK, reason: 'x', typed: 'so-2026-0088', number: 'SO-2026-0088' })?.key).toBe('cancel.held.number')
    expect(cancelConfirmHeld({ check: CANCEL_CHECK, reason: 'x', typed: ' SO-2026-0088 ', number: 'SO-2026-0088' })).toBeNull()
  })
})

describe('the payment schedule and the Changes tab', () => {
  it('an open step past its day is overdue; a paid one never', () => {
    expect(isOverdue(SCHEDULE.steps[1]!, '2026-12-11')).toBe(true)
    expect(isOverdue(SCHEDULE.steps[1]!, '2026-12-10')).toBe(false)
    expect(isOverdue(SCHEDULE.steps[0]!, '2027-01-01')).toBe(false)
  })
  it('before → after per line and size, the money change only with the price grain', () => {
    const first = AMENDMENTS.amendments[0]!
    const rows = compareRows(first.before!, first.after!)
    expect(rows.map((row) => [row.seq, row.change, row.piecesBefore, row.piecesAfter])).toEqual([
      [10, 'CHANGED', 8, 10],
      [20, null, 6, 6],
    ])
    expect(sizesText(rows[0]!.sizes)).toBe('50: 2 → 3 · 52: 2 → 3')
    expect(moneyChange(first.diff)).toEqual({ before: 624000, after: 714000, delta: 90000 })
    expect(moneyChange({ netAmountBefore: undefined, netAmountAfter: undefined })).toBeNull()
    expect(changeLabel(AMEND_PREVIEW.diff!.lines[1]!, order('CONFIRMED'), { [STYLE_ID]: STYLE })).toEqual({ line: '30', what: 'DEMO-JKT-01 · BRN' })
    expect(changeLabel(AMEND_PREVIEW.diff!.lines[0]!, order('CONFIRMED'), {})).toEqual({ line: '10', what: 'DEMO-JKT-01 · BLK' })
  })
})

describe('a typed New order (no draft row: the page holds it)', () => {
  const header = { companyId: 'c1', partyId: PARTY.id, contactId: 'k1', customerRef: ' PO-1 ' }
  const lines: DraftLine[] = [
    { key: newKey(STYLE_ID, 'blk'), lineId: null, styleId: STYLE_ID, colourwayId: 'blk', sizes: { '48': 2, '50': 0 }, price: '', locked: false },
    { key: newKey(STYLE_ID, 'brn'), lineId: null, styleId: STYLE_ID, colourwayId: 'brn', sizes: {}, price: '430', locked: false },
  ]
  it('the address holds the dialog’s answers; the body sends only lines with pieces (empty price: the list price)', () => {
    const address = newOrderAddress('/w/DEMO', header)
    expect(address).toBe(`/w/DEMO/sales/orders/new?company=c1&party=${PARTY.id}&contact=k1&ref=PO-1`)
    expect(headerFromAddress(new URL(address, 'http://x').searchParams)).toEqual({ ...header, customerRef: 'PO-1' })
    expect(headerFromAddress(params('company=c1'))).toBeNull()
    expect(manualLines(lines)).toEqual([{ styleId: STYLE_ID, colourwayId: 'blk', sizes: [{ size: '48', quantity: 2 }] }])
    expect(manualBody(header, { lines, requestedDate: '', promiseDate: '2026-12-08', internalNote: ' ' })).toEqual({ companyId: 'c1', partyId: PARTY.id, contactId: 'k1', customerRef: 'PO-1', promiseDate: '2026-12-08', lines: manualLines(lines) })
  })
  it('the draft survives a reload of the tab; anything unreadable is no draft', () => {
    expect(draftKey(header)).toBe(`factory:new-order:c1:${PARTY.id}`)
    expect(parseDraft(JSON.stringify({ lines, requestedDate: '2026-12-01', promiseDate: '', internalNote: 'x' }))?.lines[0]!.sizes).toEqual({ '48': 2 })
    expect(parseDraft('{nope')).toBeNull()
    expect(parseDraft(JSON.stringify({ lines: 'x' }))).toBeNull()
  })
  it('the preview’s nets by line; Confirm held with its reason', () => {
    const typed: DraftLine[] = [
      { key: 'a', lineId: null, styleId: STYLE_ID, colourwayId: MANUAL_PREVIEW.order!.lines[0]!.colourwayId, sizes: { '48': 2 }, price: '', locked: false },
      { key: 'b', lineId: null, styleId: STYLE_ID, colourwayId: BRN.id, sizes: { '50': 2 }, price: '430', locked: false },
    ]
    expect(previewByKey({ lines: typed }, MANUAL_PREVIEW)).toEqual({ nets: { a: 360000, b: 172000 }, prices: { a: '450', b: '430' } })
    const draft = { lines: typed, requestedDate: '', promiseDate: '', internalNote: '' }
    const ready = { phase: 'ready' as const, value: MANUAL_PREVIEW, problem: null }
    expect(confirmHeld({ can: canOf('sales'), draft, preview: ready, today: TODAY, busy: false })).toBeNull()
    expect(confirmHeld({ can: canOf('finance'), draft, preview: ready, today: TODAY, busy: false })?.key).toBe('held.noManage')
    expect(confirmHeld({ can: canOf('sales'), draft: { ...draft, lines: [] }, preview: ready, today: TODAY, busy: false })?.key).toBe('newOrder.held.lines')
    expect(confirmHeld({ can: canOf('sales'), draft: { ...draft, promiseDate: '2026-10-01' }, preview: ready, today: TODAY, busy: false })?.key).toBe('newOrder.problem.past')
    expect(confirmHeld({ can: canOf('sales'), draft, preview: { phase: 'reading', value: null, problem: null }, today: TODAY, busy: false })?.key).toBe('newOrder.held.pricing')
    expect(confirmHeld({ can: canOf('sales'), draft, preview: { ...ready, value: { ...MANUAL_PREVIEW, ok: false } }, today: TODAY, busy: false })?.key).toBe('newOrder.held.problems')
  })
  it('a customer takes an order only when active with a tax identity in force', () => {
    expect(newOrderHeld(PARTY)).toBeNull()
    expect(newOrderHeld(null)?.key).toBe('newOrder.held.customer')
    expect(newOrderHeld({ ...PARTY, status: 'BLOCKED' })).toEqual({ key: 'newOrder.held.party', params: { status: 'BLOCKED' } })
    expect(newOrderHeld({ ...PARTY, taxIdentities: [] })?.key).toBe('newOrder.held.identity')
    expect(OFFICE_PAGES.has('/sales/orders/new')).toBe(true)
  })
})

describe('B-W2b-16: waive a step, the close\'s reason code', () => {
  const can = { manageOrders: true, manageInvoices: true, waive: true }
  const step = (over: Partial<Milestone> = {}): Milestone => ({ ...SCHEDULE.steps[1]!, ...over })
  it('offers Waive… on an open deposit or before-shipping step, held without the right or on a final order', () => {
    expect(waiveVerbOf(step(), order('CONFIRMED'), can)).toEqual({ kind: 'waive', held: null })
    expect(waiveVerbOf(step({ kind: 'DEPOSIT' }), order('CONFIRMED'), can)).toEqual({ kind: 'waive', held: null })
    expect(waiveVerbOf(step({ status: 'PAID' }), order('CONFIRMED'), can)).toBeNull()
    expect(waiveVerbOf(step({ kind: 'ON_INVOICE' }), order('CONFIRMED'), can)).toBeNull()
    expect(waiveVerbOf(step(), order('CONFIRMED'), { ...can, waive: false })?.held?.key).toBe('schedule.verbs.held.noWaive')
    // The step's other verbs are unchanged (the finance tests hold them).
    expect(stepVerbs(step(), order('CONFIRMED'), can).map((verb) => verb.kind)).toEqual(['open'])
    expect(waiveHeld(order('CANCELLED'), can)?.key).toBe('schedule.verbs.held.final')
    expect(waiveReasonProblem('ok')).toBe('schedule.verbs.waiveReasonHeld')
    expect(waiveReasonProblem('Long-standing customer.')).toBeNull()
  })
  it('asks a code of the cancel list when the list is read; none when it could not be read', () => {
    const value = order('PARTLY_SHIPPED')
    const reasons = [{ code: 'CUSTOMER_REQUEST' }, { code: 'OTHER' }]
    const first = value.lines[0]!.id
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', '', reasons)?.key).toBe('closeLines.problem.reasonCode')
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', 'NOPE', reasons)?.key).toBe('closeLines.problem.reasonCode')
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', 'CUSTOMER_REQUEST', reasons)).toBeNull()
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', '', null)).toBeNull()
    expect(closeChoiceProblem(value, [first], ' ', 'CUSTOMER_REQUEST', reasons)?.key).toBe('closeLines.problem.reason')
  })
})
