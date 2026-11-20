import { readFileSync } from 'node:fs' // F-SA-213
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
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
import { TILE_KEYS, WAIT_REASONS } from './api' // F-SA-214
import { WAIT_WORDS } from '@nexus/factory-domain/sales/orders-depth/rules' // F-SA-214
import { boardRereadOf, offBoard, waitDoorsOf } from './model' // F-SA-214
import { BOARD_LANES, DEPOSIT_KINDS, DEPOSIT_REQUEST_STATUSES, DEPOSIT_STATES, INVOICE_DOC_TYPES, INVOICE_STATUSES, LINK_STATES, ORDER_ACTIONS, ORDER_STATUSES, SDI_NEXT_ACTIONS, SDI_STATE_CODES, SETTLEMENT_GAPS, SHIPMENT_STATUSES, WORK_ORDER_STATUSES } from './api'
import { AMEND_PREVIEW, AMENDMENTS, BOARD, BRN, CANCEL_BLOCKED, CANCEL_CHECK, canOf, deposit, LIST_ROWS, MANUAL_PREVIEW, order, PAID, PARTY, SCHEDULE, SENT_LINK, STYLE, STYLE_ID, TD02, TODAY } from './_demo/fixtures'
import { DAILY_ORDER_ACTIONS, IMPACT_CODES, LINE_CHANGES, MILESTONE_KINDS, MILESTONE_STATUSES, type Milestone } from './api'
import { stepVerbs, waiveHeld, waiveReasonProblem, waiveVerbOf } from './record/schedule/model'
// F-SA-213: the board card's facts and name; the office's priority levels (the row schema's and the depth read's).
import { cardFacts, cardName, SHIPPED_LANES } from './list/view/OrdersBoard'
import { PRIORITY_LEVELS } from './depth/api'
import { ORDER_PRIORITY_LEVELS } from './api'
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
  cellFloorsOf, // F-OP-107
  cellIssuesOf, // F-OP-107
  withCells,
  type DraftLine,
} from './daily-model'
import { confirmHeld, draftKey, headerFromAddress, manualBody, newOrderAddress, newOrderHeld, parseDraft, previewByKey } from './new/new-model'
import { designScreen as changesScreen } from './record/changes/fixtures'
import { runWithStepUp } from './hooks'
import { isMadeToMeasure, MENU_GROUPS, RECORD_TABS, tabCountOf } from './model' // F-SA-230
import { abilitiesOf, PAGE_ACT_RIGHTS, readOnlyOnPage } from './model' // F-OP-303 (walk #6)
import { ROLES, type Role } from './_demo/fixtures' // F-OP-303
import { BAND_LOOK_ITEMS, bandMenuFor, bandStepOf } from './model' // F-OP-311 (oo-walk #10)
import { rolePermissions } from '../../../shell/design-data' // F-OP-311
import { bandHealthOf, healthInputOf } from './record/overview/model' // F-SA-232: the band's chip
import { HISTORY_CHIPS, historyFor, historyOf, waitingOnUsOf } from './record/changes/model' // F-SA-236 (F-OP-301: the customer's side is the ONE waiting list's)
import { designScreen as listScreen } from './list/fixtures'
// B-TH-201
import { getBoard, listOrders } from './api'
import { listPromiseLines } from './depth/api'
import {
  boardLanes,
  closeHeld,
  partyFromAddress,
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
  nextStep,
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
import { artworkOfGroup } from './record/production' // F-SA-231b
import { textOf } from '../../../lib/record-thread/parts/testing' // F-SA-231b
// ---- F-OO-112 (B-OO-002, Owner D1): Mark ready after quality released every piece ----
import { orderActions, READY_QUALITY_WORDS, releasedPiecesOf } from '@nexus/factory-domain/sales/orders/orders'
import { readyHeld } from './model'
// ---- end F-OO-112
// ---- F-OO-142 (B-OO-009): the promise dialog's reason list ----
import { PROMISE_REASON_CODES, PROMISE_REASON_WORDS, promiseReasonOf, promiseReasonText } from '@nexus/factory-domain/sales/portal-orders/promise'
import { isPromiseReasonCode, promiseBodyOf, promiseReasonChoices, promiseReasonPreview } from './model'
// ---- end F-OO-142
// ---- F-OO-206 (Owner D8): one count at both ends ----
import { orderLinkCountsOf } from '@nexus/factory-domain/sales/orders/linked-counts'
import { linkedRowsOf } from './record/overview/linked'
import { orderSchema } from './api'
// ---- end F-OO-206

// ---- F-OO-142 (end check fix wave): the DS Modal draws into a portal once hydrated, never on the server, so the promise dialog's
// words could not be read here. As lines-held's, facts' and where's dialog tests do: an open Modal draws in place (title,
// subtitle, body, footer); a closed one draws nothing, so a case with no dialog draws as before.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog', 'data-modal': '' }, createElement('h2', null, title as never), subtitle != null ? createElement('p', null, subtitle as never) : null, children as never, footer as never) : null
  return { ...actual, Modal }
})
// ---- end F-OO-142

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
    // B-W2b-323: + reaccept (Waiting for the customer to accept a change). F-SA-214: + Waiting for approval, second.
    expect(TILES.map((tile) => tile.rows)).toEqual(['late', 'PENDING_APPROVAL', 'deposit', 'IN_PRODUCTION', 'READY', 'reaccept'])
    expect(TILES.map((tile) => tile.key)).toEqual([...TILE_KEYS])
    // The board's own filters mean the same rows as the tiles' saved views.
    for (const tile of BOARD.tiles) expect(rowsQuery(TILES.find((entry) => entry.key === tile.key)!.rows, '')).toMatchObject(Object.fromEntries(Object.entries(tile.filter).map(([key, value]) => [key, key === 'late' || key === 'reaccept' /* B-W2b-323 */ ? true : value])))
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
  // F-SA-201 (P22): a Delivered order's primary is Close order, as a Shipped one's (it was "Change promise date").
  it('Delivered → Close order: free when settled, held in words when not (orders.close may close it with a reason)', () => {
    expect(nextStep(order('DELIVERED', { settled: true }), canOf('sales'))).toEqual({ kind: 'close', held: null })
    expect(nextStep(order('DELIVERED'), canOf('sales'))).toEqual({ kind: 'close', held: { key: 'held.notSettled' } })
    expect(nextStep(order('DELIVERED'), canOf('finance'))).toEqual({ kind: 'close', held: null })
    expect(closeHeld(order('DELIVERED', { settled: true }), canOf('manager'))?.key).toBe('held.noClose')
    expect(settlementWords(order('DELIVERED'))).toEqual(['settlement.BALANCE_DUE', 'settlement.AT_SDI'])
    // Only a shipped (or delivered) order is closed; the API's own actions say the same.
    for (const status of ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const) expect(closeHeld(order(status, { settled: true }), canOf('owner'))?.key, status).toBe('held.closeState')
    expect(order('DELIVERED').actions.map((entry) => entry.action)).toEqual(['changePromise', 'close'])
  })
  // F-OO-142 (B-OO-009): why is a curated reason the customer reads, picked from the list ("Pick why"); the note is the office's own.
  // F-OL-04 (ol-s1, B-OL-004): the reason is optional — none picked is no problem (the server's automatic words); a wrong code still is.
  it('a promise change: a day from today, a reason optional (a code the API does not know refused), a line when lines are chosen', () => {
    expect(promiseProblems({ date: '', reasonCode: 'CAPACITY', today: TODAY, current: null, lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.date' })
    expect(promiseProblems({ date: '2026-10-28', reasonCode: 'CAPACITY', today: TODAY, current: null, lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.past' })
    expect(promiseProblems({ date: '2026-12-15', reasonCode: 'CAPACITY', today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({ date: 'promise.problem.same' })
    expect(promiseProblems({ date: '2026-12-15', reasonCode: '', today: TODAY, current: null, lineIds: [], allLines: false })).toEqual({ lines: 'promise.problem.lines' })
    // A code the API does not know is refused; none picked is fine (optional).
    expect(promiseProblems({ date: TODAY, reasonCode: 'WEATHER', today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({ reasonCode: 'promise.problem.code' })
    expect(promiseProblems({ date: TODAY, reasonCode: null, today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({})
    expect(promiseProblems({ date: TODAY, reasonCode: 'MATERIAL_LATE', today: TODAY, current: '2026-12-15', lineIds: [], allLines: true })).toEqual({})
  })
  it('tabs from the address; the chain’s ids for live events', () => {
    // F-SA-230: the tabs re-cut — an old tab lands on its new tab (and section); the five stay as they are.
    expect(tabOf('money')).toBe('money')
    // F-SA-232: Overview is the first tab (no address, an unknown one, Activity with the thread).
    expect(tabOf('activity')).toBe('overview')
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) expect(tabOf(name)).toBe('overview') // TH-6 part B: never a name of Object's own
    for (const tab of ['overview', 'lines', 'production', 'changes', 'money', 'shipments', 'files'] as const) expect(tabOf(tab)).toBe(tab)
    expect(tabOf('nope')).toBe('overview')
    // B-TH-301 + F-SA-230: every address the old nine tabs (and the five) had lands on its tab today.
    const OLD: Record<string, string> = { lines: 'lines', dates: 'production', production: 'production', shipments: 'shipments', money: 'money', invoices: 'money', changes: 'changes', documents: 'changes', confirmation: 'changes', margin: 'money', activity: 'overview' }
    for (const [old, merged] of Object.entries(OLD)) expect(tabOf(old), old).toBe(merged)
    const ids = knownIds(order('SHIPPED'))
    expect(ids.has(order('SHIPPED').id)).toBe(true)
    expect(ids.has(TD02.id)).toBe(true)
    // F-SA-239: which events the record re-reads on is the order read's own watch list (record/live.ts, its own tests).
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

  // SCR-199 (the customer's deposit page) is held by links/pay/pay.vitest.test.ts since B-W2b-199.

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
    expect(reviewHeld(draft, value, { changed: false })?.key).toBe('amend.held.nothing')
    expect(reviewHeld(draft, value, { changed: true })).toBeNull()
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
    expect(reviewHeld(draft.map((line) => (line.lineId === black.id ? { ...line, price: '4,5,0' } : line)), value, { changed: false })?.key).toBe('amend.held.price')
    // Every line at 0: an order keeps at least one line.
    expect(reviewHeld(withCells(draftOf(value), { [black.id]: {}, [red.id]: {} }), value, { changed: false })?.key).toBe('amend.held.empty')
  })
  // F-OP-107 (B2; lead note after B-SA-042, R1): a size may go under what work orders make (the work order follows) and under what is
  // already CUT (its extra pieces get an outcome in the strip) — never under what already SHIPPED.
  it('per cell: under what shipped holds Apply; under what is cut a warning (no hold); under what work orders make the work order follows', () => {
    const production = order('IN_PRODUCTION')
    const black = lineOf(production, 10)
    const draft = withCells(draftOf(production), { [black.id]: { '48': 1, '50': 2, '52': 2, '54': 2 } })
    expect(cellIssuesOf(draft, {}, minimumsOf(production))).toEqual([{ key: black.id, size: '48', kind: 'inWork', count: 2 }])
    expect(reviewHeld(draft, production, { changed: false })).toBeNull()
    // 2 already cut in 48: 1 is 1 under the cut — a warning (the extra piece's outcome is picked in the strip), not also "in work orders".
    const read = (sizes: { size: string | null; cut: number | null; shipped: number }[]) => [{ lineId: black.id, cut: 2, sewn: null, shipped: 0, sizes }]
    const floors = cellFloorsOf(read([{ size: '48', cut: 2, shipped: 0 }, { size: '50', cut: null, shipped: 0 }, { size: '52', cut: 0, shipped: 0 }]))
    expect(floors).toEqual({ [black.id]: { '48': { cut: 2, shipped: 0 } } })
    expect(cellIssuesOf(draft, floors, minimumsOf(production))).toEqual([{ key: black.id, size: '48', kind: 'cut', count: 1 }])
    expect(reviewHeld(draft, production, { changed: false }, floors)).toBeNull()
    // 2 shipped in 48: under it is an error and Apply waits.
    const shipped = cellFloorsOf(read([{ size: '48', cut: 2, shipped: 2 }]))
    expect(cellIssuesOf(draft, shipped)).toEqual([{ key: black.id, size: '48', kind: 'shipped', count: 2 }])
    expect(reviewHeld(draft, production, { changed: false }, shipped)?.key).toBe('edit.held.shipped')
    // At the floor: open again; a line kept as it is (closed short) never has one.
    expect(reviewHeld(withCells(draftOf(production), { [black.id]: { '48': 2, '50': 2, '52': 2, '54': 1 } }), production, { changed: false }, shipped)).toBeNull()
    expect(cellIssuesOf(draft.map((line) => ({ ...line, locked: true })), shipped)).toEqual([])
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['edit.held.shipped', 'edit.floor.shipped', 'edit.floor.cut', 'edit.floor.inWork', 'edit.figures.cut', 'edit.figures.sewn', 'edit.figures.shipped']) expect(t(key, { count: 2 }), `${locale}: ${key}`).not.toBe(key)
      for (const gone of ['amend.held.cut', 'editor.underCut', 'editor.underWorkOrders']) expect(t(gone, { size: '48', cut: 2, made: 2 }), `${locale}: ${gone}`).toBe(gone)
    }
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
  // F-OL-04 (ol-s1, B-OL-004): the code and the words are optional; a code picked is one of the list; one that asks for detail wants words.
  it('the reason is optional: no code and no words is fine; a code not on the list is refused; a code asking for detail wants a few words', () => {
    const value = order('PARTLY_SHIPPED')
    const reasons = [{ code: 'CUSTOMER_REQUEST' }, { code: 'OTHER', needsDetail: true }]
    const first = value.lines[0]!.id
    expect(closeChoiceProblem(value, [first], '', '', reasons)).toBeNull()
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', 'NOPE', reasons)?.key).toBe('closeLines.problem.reasonCode')
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', 'CUSTOMER_REQUEST', reasons)).toBeNull()
    expect(closeChoiceProblem(value, [first], 'The rest is not wanted.', '', null)).toBeNull()
    expect(closeChoiceProblem(value, [first], ' ', 'CUSTOMER_REQUEST', reasons)).toBeNull()
    expect(closeChoiceProblem(value, [first], 'ok', 'OTHER', reasons)?.key).toBe('lineMenu.held.detail')
    expect(closeChoiceProblem(value, [first], 'Not wanted', 'OTHER', reasons)).toBeNull()
  })
})

// ── B-TH-201 (SHEET-G11, SHEET-G01): one customer's orders, `?party=<id>` ─────────────────────────────────────────────────
describe('one customer’s orders from the address (B-TH-201)', () => {
  const PARTY_A = '0190a1b2-0000-7000-8000-00000000000a'
  const recorder = () => {
    const calls: Array<{ path: string; query: Record<string, unknown> }> = []
    const api = { get: async (path: string, options?: { query?: Record<string, unknown> }) => (calls.push({ path, query: options?.query ?? {} }), {}) } as unknown as Parameters<typeof listOrders>[0]
    return { api, calls }
  }

  it('reads ?party= (an id only) and writes it back with every rows view, search and layout', () => {
    expect(partyFromAddress(params(`party=${PARTY_A}`))).toBe(PARTY_A)
    expect(partyFromAddress(params(`party=${PARTY_A.toUpperCase()}`))).toBe(PARTY_A)
    // The code the old drill sent, or anything else, is no customer: every customer stays on screen, nothing is narrowed by a guess.
    expect(partyFromAddress(params('party=DEMO-C1'))).toBeNull()
    expect(partyFromAddress(params(''))).toBeNull()
    expect(partyFromAddress(null)).toBeNull()
    for (const rows of ROW_VIEWS) {
      const address = new URL(listAddress('/w/DEMO/sales/orders', { rows, q: 'SO', layout: 'board', party: PARTY_A }), 'http://x').searchParams
      expect(partyFromAddress(address), rows).toBe(PARTY_A)
      expect(rowsFromAddress(address), rows).toBe(rows)
    }
    expect(listAddress('/p', { rows: 'all', q: '', layout: 'list', party: PARTY_A })).toBe(`/p?rows=all&party=${PARTY_A}`)
    expect(listAddress('/p', { rows: 'open', q: '', layout: 'list', party: null })).toBe('/p')
  })

  it('passes partyId to the list, each board lane, the tiles and By promise week; none without the term', async () => {
    expect(rowsQuery('late', 'x', null, PARTY_A)).toMatchObject({ late: true, q: 'x', partyId: PARTY_A })
    expect(rowsQuery('open', '')).not.toHaveProperty('partyId')
    expect(laneQuery('READY', 'all', '', PARTY_A)).toMatchObject({ status: 'READY', partyId: PARTY_A })
    expect(laneQuery('READY', 'all', '')).not.toHaveProperty('partyId')
    const { api, calls } = recorder()
    await listOrders(api, rowsQuery('all', '', null, PARTY_A))
    await getBoard(api, '', undefined, PARTY_A)
    await listPromiseLines(api, 'site-1', { q: '', partyId: PARTY_A })
    await listOrders(api, rowsQuery('all', ''))
    await getBoard(api, '')
    await listPromiseLines(api, 'site-1', { q: '' })
    expect(calls.map((call) => [call.path, call.query.partyId])).toEqual([
      ['/sales/orders', PARTY_A],
      ['/sales/orders/board', PARTY_A],
      ['/planning/promises', PARTY_A],
      ['/sales/orders', undefined],
      ['/sales/orders/board', undefined],
      ['/planning/promises', undefined],
    ])
  })

})
// ── end B-TH-201 ──

// ---- F-SA-213 (sales page plan N8, picks P13, P15, P18; 12-lists-board §3.3): the board card with the photo -----------------------
describe('the board card (F-SA-213): photo left, the label that adds something, priority, the customer\'s mark, a held verb', () => {
  const can = { makeWorkOrders: true, createShipment: true }
  const base = LIST_ROWS[0]!
  const card = (over: Partial<typeof base>) => cardFacts({ ...base, ...over }, can)

  it('the shipped bar only in Ready · Partly shipped · Shipped (elsewhere "0 of 40" is noise)', () => {
    expect([...SHIPPED_LANES]).toEqual(['READY', 'PARTLY_SHIPPED', 'SHIPPED'])
    for (const status of ORDER_STATUSES) expect(card({ status }).shippedBar, status).toBe(SHIPPED_LANES.includes(status))
  })
  it('the label only when it adds something: never the customer\'s own label; our own collection and a hidden label say so', () => {
    expect(card({ brands: [{ partyId: base.partyId, name: base.partyName, own: false }] }).labels).toEqual([])
    expect(card({ brands: [{ partyId: null, name: null, own: true }] }).labels).toEqual([{ kind: 'own' }])
    expect(card({ brands: [{ partyId: null, name: null, own: false }] }).labels).toEqual([{ kind: 'hidden' }])
    expect(card({ brands: [{ partyId: 'label-b', name: 'Brand Beta', own: false }] }).labels).toEqual([{ kind: 'named', name: 'Brand Beta' }])
  })
  it('"Priority · <level>" only when not Normal; "Urgent (customer)" only for the customer\'s own mark', () => {
    expect(card({ priority: { level: 'NORMAL', number: 0, urgentReason: null } }).priority).toBeNull()
    expect(card({ priority: undefined }).priority).toBeNull()
    expect(card({ priority: { level: 'HIGH', number: 1, urgentReason: null } }).priority).toBe('HIGH')
    expect(card({ priority: { level: 'URGENT', number: 1, urgentReason: 'Fair' } }).priority).toBe('URGENT')
    expect(card({ customerUrgency: 'URGENT' }).customerUrgent).toBe(true)
    expect(card({ customerUrgency: 'REGULAR' }).customerUrgent).toBe(false)
    expect([...ORDER_PRIORITY_LEVELS]).toEqual([...PRIORITY_LEVELS])
  })
  it('the verb is held with why while the deposit waits (never hidden); without the right there is none', () => {
    expect(card({ status: 'CONFIRMED', deposit: { state: 'OPEN', dueDate: '2026-11-30' } }).verb).toEqual({ kind: 'makeWorkOrders', held: 'board.held.deposit' })
    expect(card({ status: 'CONFIRMED', deposit: { state: 'MISSING', dueDate: null } }).verb).toEqual({ kind: 'makeWorkOrders', held: 'board.held.deposit' })
    expect(card({ status: 'CONFIRMED', deposit: { state: 'PAID', dueDate: null } }).verb).toEqual({ kind: 'makeWorkOrders', held: null })
    expect(card({ status: 'READY' }).verb).toEqual({ kind: 'createShipment', held: null })
    expect(cardFacts({ ...base, status: 'CONFIRMED' }, { makeWorkOrders: false, createShipment: false }).verb).toBeNull()
    expect(card({ status: 'IN_PRODUCTION' }).verb).toBeNull()
  })
  it('the words in both languages; the card\'s accessible name says number, customer, pieces, promise and new messages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['board.priority', 'board.customerUrgent', 'board.held.deposit', 'board.cardPromised', 'board.cardNoPromise']) expect(t(key, { level: 'X', date: 'D' }), `${locale} ${key}`).not.toBe(key)
      expect(t('board.cardPieces', { count: 2 }), locale).not.toBe('board.cardPieces')
      expect(t('board.cardNew', { count: 2 }), locale).not.toBe('board.cardNew')
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const named = cardName(en, { number: 'SO-2026-0142', partyName: 'Brand Alpha', units: 40, promiseDate: '2026-11-18' }, 'en', 2)
    expect(named.startsWith('SO-2026-0142, Brand Alpha, 40 pieces, promised ')).toBe(true)
    expect(named.endsWith(', 2 new messages')).toBe(true)
    expect(cardName(en, { number: 'SO-1', partyName: 'Brand Beta', units: 1, promiseDate: null }, 'en', 0)).toBe('SO-1, Brand Beta, 1 piece, no promise')
    expect(en('board.priority', { level: 'Top' })).toBe('Priority · Top')
  })
  it('the card mounts the ONE picture part at its board size (fit) and the lanes are 260 px, an empty one 160 px', () => {
    const view = readFileSync(new URL('./list/view/OrdersBoard.tsx', import.meta.url), 'utf8')
    const css = readFileSync(new URL('./orders.css', import.meta.url), 'utf8')
    expect(view).toContain('size="board"')
    expect(view).toContain('<PictureViewer')
    expect(css).toMatch(/\.fw-so-lane \{\s*flex: 1 0 260px;/)
    expect(css).toMatch(/\.fw-so-lane\.is-empty \{\s*flex: 0 0 160px;/)
    expect(css).toContain('scroll-snap-type: x proximity')
  })
})
// ---- end F-SA-213

// ---- F-SA-214 (sales page plan N8 / N7, picks P12, P13, P17; 12-lists-board §3.1, §3.4, §3.5): the waiting lane, Delivered, live ----
describe('the board\'s Waiting for approval lane, its reasons with doors, Delivered under the board, the live re-read (F-SA-214)', () => {
  const base = LIST_ROWS[0]!
  const waiting = (waits: (typeof WAIT_REASONS)[number][] | null) => ({ ...base, status: 'PENDING_APPROVAL' as const, waits })
  const reader = { measurements: true }
  const noMeasures = { measurements: false }

  it('the reasons mirror factory-domain\'s WAIT_WORDS (the screen has words for every code the API sends)', () => {
    expect([...WAIT_REASONS].sort()).toEqual(Object.keys(WAIT_WORDS).sort())
  })
  it('each reason once, each with its door: a yes asked → Approvals; nobody asked / credit → the order; the review → Riders (right holders only)', () => {
    expect(waitDoorsOf(waiting(['REQUEST_PENDING']), '/w/DEMO', reader)).toEqual([{ word: 'waits.yes', href: '/w/DEMO/home/approvals?kind=SALES_ORDER' }])
    expect(waitDoorsOf(waiting(['NO_REQUEST']), '/w/DEMO', reader)).toEqual([{ word: 'waits.yes', href: `/w/DEMO/sales/orders/${base.id}` }])
    expect(waitDoorsOf(waiting(['CREDIT_HOLD']), '/w/DEMO', reader)).toEqual([{ word: 'waits.credit', href: `/w/DEMO/sales/orders/${base.id}` }])
    expect(waitDoorsOf(waiting(['MEASUREMENTS']), '/w/DEMO', reader)).toEqual([{ word: 'waits.review', href: `/w/DEMO/sales/made-to-measure?segment=riders&view=waiting&party=${base.partyId}` }])
    // Without sales.measurements.view: the words, no door to the riders (body data).
    expect(waitDoorsOf(waiting(['MEASUREMENTS']), '/w/DEMO', noMeasures)).toEqual([{ word: 'waits.review', href: null }])
    // A yes asked and none asked say "Waits for a yes" once (the first door wins).
    expect(waitDoorsOf(waiting(['REQUEST_PENDING', 'NO_REQUEST', 'CREDIT_HOLD']), '/w/DEMO', reader).map((door) => door.word)).toEqual(['waits.yes', 'waits.credit'])
    // Another state, or no reason read: nothing.
    expect(waitDoorsOf({ ...base, status: 'CONFIRMED', waits: ['CREDIT_HOLD'] }, '/w/DEMO', reader)).toEqual([])
    expect(waitDoorsOf(waiting(null), '/w/DEMO', reader)).toEqual([])
  })
  it('Delivered has no lane: counted under the board beside closed and cancelled', () => {
    expect(offBoard({ ...BOARD, byStatus: [...BOARD.byStatus, { status: 'DELIVERED', count: 4 }] })).toEqual({ closed: 12, cancelled: 1, delivered: 4 })
    expect(offBoard(BOARD)).toEqual({ closed: 12, cancelled: 1, delivered: 0 })
    expect(offBoard(null)).toBeNull()
  })
  it('a state that moved re-reads only its from and to lanes; a new order the lanes it may enter; another change the lane holding it', () => {
    const lanes = BOARD_LANES.map((status) => ({ status, items: LIST_ROWS.filter((row) => row.status === status) }))
    expect(boardRereadOf({ type: 'sales_order.status_changed', fields: { orderId: 'x', number: 'SO-1', from: 'CONFIRMED', to: 'IN_PRODUCTION' } }, lanes)).toEqual(['CONFIRMED', 'IN_PRODUCTION'])
    expect(boardRereadOf({ type: 'sales_order.status_changed', fields: { orderId: 'x', number: 'SO-1', from: 'PENDING_APPROVAL', to: 'CONFIRMED' } }, lanes)).toEqual(['PENDING_APPROVAL', 'CONFIRMED'])
    // A move to a state without a lane (closed) re-reads only the lane it left.
    expect(boardRereadOf({ type: 'sales_order.status_changed', fields: { orderId: 'x', number: 'SO-1', from: 'SHIPPED', to: 'CLOSED' } }, lanes)).toEqual(['SHIPPED'])
    expect(boardRereadOf({ type: 'sales_order.created', fields: { orderId: 'x', number: 'SO-9' } }, lanes)).toEqual(['PENDING_APPROVAL', 'CONFIRMED'])
    const held = LIST_ROWS.find((row) => row.status === 'IN_PRODUCTION')!
    expect(boardRereadOf({ type: 'sales_order.promise_changed', fields: { orderId: held.id, number: held.number } }, lanes)).toEqual(['IN_PRODUCTION'])
    expect(boardRereadOf({ type: 'sales_order.promise_changed', fields: { orderId: 'not-on-screen', number: 'SO-0' } }, lanes)).toEqual([])
    // Only the lanes the board shows (a state's view shows one lane).
    expect(boardRereadOf({ type: 'sales_order.status_changed', fields: { orderId: 'x', number: 'SO-1', from: 'CONFIRMED', to: 'IN_PRODUCTION' } }, lanes.filter((lane) => lane.status === 'READY'))).toEqual([])
  })
  it('the words in both languages: the tile, the reasons, Delivered under the board, an empty lane', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['tile.waitingForApproval', 'waits.yes', 'waits.credit', 'waits.review', 'lane.none']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('offBoard.delivered', { count: 3 }), locale).toContain('3')
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('offBoard.delivered', { count: 3 })).toBe('3 delivered · See them in the list')
    // Round 5 (R9): PENDING_APPROVAL reads the catalogue's "Waiting for a yes" everywhere — the pill, the board lane, the tile.
    expect(en('tile.waitingForApproval')).toBe('Waiting for a yes')
    expect(en('tile.waitingForApproval')).toBe(en('status.PENDING_APPROVAL'))
  })
  it('the board holds live re-reads while a card has the focus or its picture is open, and draws the reasons on the waiting cards', () => {
    const view = readFileSync(new URL('./list/view/OrdersBoard.tsx', import.meta.url), 'utf8')
    const page = readFileSync(new URL('./list/use-orders-sheet.ts', import.meta.url), 'utf8') // F-SA-220: the sheet's body moved there
    expect(view).toContain('onBoardHold')
    expect(view).toContain('waitDoorsOf(row')
    expect(view).toContain("t('lane.none')")
    expect(view).not.toContain('board.laneEmpty')
    expect(page).toContain('boardRereadOf(change')
  })
})
// ---- end F-SA-214

// ---- F-SA-230: the order's tabs re-cut — what each counts, the band's health and Made to measure ------------------------------
describe('F-SA-230: the tab counts, the band’s health chip, Made to measure', () => {
  it('each tab counts what it lists: Money the invoices (no longer Shipments), Shipments the shipments only', () => {
    const value = order('SHIPPED')
    expect(tabCountOf('lines', value)).toBe(value.lines.length)
    expect(tabCountOf('production', value)).toBe(value.chain.workOrders.length)
    // F-OP-117 (R-22): Changes is the ONE waiting list's count, null until the production read gives it (never a made-up 0).
    expect(tabCountOf('changes', value)).toBeNull()
    expect(tabCountOf('changes', value, { changes: 0 })).toBe(0)
    expect(tabCountOf('changes', value, { changes: 3 })).toBe(3)
    // F-OO-206 (D8): the chain by the one rule — every invoice of this shipped order is issued and its deposit is paid; both shipments stand.
    expect(tabCountOf('money', value)).toBe(value.chain.invoices.length)
    expect(tabCountOf('shipments', value)).toBe(value.chain.shipments.length)
  })

  it('the health chip only for a late order still to ship (never On track), from the order read until the production read comes', () => {
    const band = (daysLate: number | null, status: Parameters<typeof healthInputOf>[0]['status']) => healthInputOf({ daysLate, status, promiseDate: '2026-11-10' }, null)
    expect(band(3, 'IN_PRODUCTION')).toMatchObject({ computed: 'LATE', daysLate: 3 })
    expect(bandHealthOf(band(3, 'IN_PRODUCTION'))).toBe(true)
    expect(bandHealthOf(band(0, 'IN_PRODUCTION'))).toBe(false)
    expect(bandHealthOf(band(null, 'CONFIRMED'))).toBe(false)
    for (const status of ['SHIPPED', 'DELIVERED', 'CLOSED', 'CANCELLED'] as const) expect(bandHealthOf(band(4, status)), status).toBe(false)
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['production']).production!)('parts.health.lateBy', { count: 3 })).toMatch(/3/)
  })

  it('Made to measure when a line is made to measure; the ⋯ groups and the band words in both languages', () => {
    expect(isMadeToMeasure(order())).toBe(false)
    expect(isMadeToMeasure({ lines: [{ ...order().lines[0]!, kind: 'MADE_TO_MEASURE' }] })).toBe(true)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['record.madeToMeasure', 'menu.assignSupervisor', 'menu.askSupervisor', 'ship.moneyDoor', 'money.section.totals', 'money.section.deposit', 'money.section.margin', ...MENU_GROUPS.map((group) => `menu.group.${group}`), ...RECORD_TABS.map((tab) => `tab.${tab}`)]) expect(t(key), `${locale}: ${key}`).not.toBe(key)
    }
    expect(createTranslator('it', messagesFor('it', ['orders']).orders!)('tab.money')).toBe('Importi')
  })
})
// ---- end F-SA-230

// ---- F-SA-236: Changes, one newest-first story — what waits, the history and its chips ---------------------------------------------
describe('F-SA-236: Changes — waiting on us, waiting on the customer, the history chips', () => {
  const request = (id: string, status: string, askedAt: string, extra: Record<string, unknown> = {}) => ({ id, status, askedAt, kind: 'CHANGE', answeredAt: null, withdrawnAt: null, counter: null, note: null, askedBy: 'Dora Esempio', answeredBy: null, ...extra }) as never
  const change = (id: string, revision: number, at: string, priced = false) => ({ id, revision, reason: 'r', createdAt: at, createdBy: 'Bea Esempio', priced, diff: { lines: [{ change: 'CHANGED', piecesBefore: 8, piecesAfter: 9 }] }, changeAmount: 4500, feeAmount: null, deposit: null, yes: { state: 'NOT_ASKED', taskId: null, reason: null }, customer: { decision: priced ? 'REFUSED' : 'NOT_NEEDED', requestId: null, answeredAt: null }, putBack: { may: true } }) as never

  it('the requests still open or countered, oldest first (the band notice names the first; the counts are the ONE waiting list\'s, F-OP-301)', () => {
    const requests = [request('b', 'OPEN', '2026-11-18T09:00:00Z'), request('a', 'COUNTERED', '2026-11-17T09:00:00Z', { counter: { at: '2026-11-17T12:00:00Z' } }), request('c', 'ACCEPTED', '2026-11-10T09:00:00Z', { answeredAt: '2026-11-11T09:00:00Z' })]
    expect(waitingOnUsOf(requests).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('the history: requests asked and answered, amendments (the changes read; priced with Put back), confirmations — newest first; chips filter', () => {
    const entries = historyOf({
      requests: [request('c', 'ACCEPTED', '2026-11-10T09:00:00Z', { answeredAt: '2026-11-11T09:00:00Z' })],
      changes: [change('ch1', 1, '2026-11-12T16:48:00Z'), change('ch2', 2, '2026-11-14T10:00:00Z', true)],
      amendments: null,
      confirmation: { versions: [{ id: 'v1', version: 1, createdAt: '2026-11-03T11:20:00Z', createdBy: null }], sentAt: '2026-11-03T11:30:00Z', sentVersion: 1 } as never,
    })
    expect(entries.map((entry) => entry.kind)).toEqual(['amendment', 'amendment', 'requestAnswered', 'requestAsked', 'confirmationSent', 'confirmationMade'])
    const priced = entries[0]!
    expect(priced.kind === 'amendment' && priced.putBack).toBe(true)
    expect(HISTORY_CHIPS).toEqual(['all', 'requests', 'amendments', 'workOrders', 'confirmations']) // F-OP-117: + Work orders
    expect(historyFor(entries, 'requests').map((entry) => entry.kind)).toEqual(['requestAnswered', 'requestAsked'])
    expect(historyFor(entries, 'amendments')).toHaveLength(2)
    expect(historyFor(entries, 'confirmations')).toHaveLength(2)
    expect(historyFor(entries, 'all')).toHaveLength(entries.length)
    // No changes read here (a design case): the amendments read stands in; never both.
    const fallback = historyOf({ requests: [], changes: null, amendments: AMENDMENTS.amendments, confirmation: null })
    expect(fallback.filter((entry) => entry.kind === 'amendment')).toHaveLength(AMENDMENTS.amendments.length)
  })

  it('one changes read: the page reads the amendments only when Before → after opens; the confirmation is a row, never the 70vh PDF', () => {
    const container = readFileSync(new URL('./record/OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain("if (next?.kind === 'compare' && current.current && !amendments?.value) readAmendments(current.current)")
    const loadParts = container.slice(container.indexOf('const loadParts = useCallback('), container.indexOf('const readAmendments = useCallback('))
    expect(loadParts).not.toContain('listAmendments(')
    const card = readFileSync(new URL('./confirmation/view/ConfirmationCard.tsx', import.meta.url), 'utf8')
    expect(card).not.toContain('PdfViewer')
    expect(card).toContain('frame.openFiles')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      // F-OO-204: the counter-offer row says the card's own words ("Our counter-offer: …", waiting.counterOpen): `changes.onUs.countered` went.
      for (const key of ['changes.onUs.title', 'changes.onUs.nothing', 'changes.onCustomer.title', 'changes.onCustomer.reaccept', 'changes.confirmation.title', 'changes.confirmation.yes', 'changes.history.title', 'changes.history.priced', ...HISTORY_CHIPS.map((chip) => `changes.history.chips.${chip}`)]) expect(t(key), `${locale}: ${key}`).not.toBe(key)
      expect(t('changes.onUs.countered'), `${locale}: changes.onUs.countered`).toBe('changes.onUs.countered')
    }
  })
})
// ---- end F-SA-236

// ---- F-SA-231: Lines = the commercial truth — the totals strip, no layer switch, pictures and artwork ----------------------------
describe('F-SA-231: Lines — totals by grain instead of the rail, no layer switch, the picture part and the artwork', () => {
  it('no layer switch: Lines draws the ordered pieces only; its rail and record chain left (Money, Overview)', () => {
    const source = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(source).not.toContain('SegmentedControl')
    expect(source).not.toContain('SummaryRail')
    expect(source).toContain("gridOf(group, 'ordered')")
    expect(source).toContain('<RecordPicture')
    const model = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    expect(model).not.toContain('SIZE_LAYERS')
  })

  it('the totals by grain and the words in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['lines.totals', 'lines.units', 'lines.readOnly', 'lines.note', 'lines.closedBy', 'lines.gridCaption']) expect(t(key, { name: 'x', day: 'y', note: 'z', style: 's' }), `${locale}: ${key}`).not.toBe(key)
      expect(t('lines.artwork', { count: 2 })).toMatch(/2/)
    }
  })
})
// ---- end F-SA-231

// ---- B-SA-035b + F-SA-231b (sa-7's follow-ups): the artwork chip opens the thread's ONE viewer; a made-to-measure line names its rider
// only with sales.measurements.view (the order read adds it under that right) — never a measurement -----------------------------------
describe('F-SA-231b: Lines — the artwork in the thread’s viewer, the rider only with the measurements right', () => {
  const file = (n: number) => ({ fileId: `f-${n}`, name: `Logo ${n}.pdf`, contentType: 'application/pdf', sizeBytes: 1000 * n })
  const caseOf = (id: string) => recordScreen.cases.find((item) => item.id === id)!.model

  it('a style card’s artwork: the files the read names, each once in the lines’ order; the read’s count where it names none', () => {
    expect(artworkOfGroup([{ artwork: [file(1), file(2)], artworkCount: 2 }, { artwork: [file(2), file(3)], artworkCount: 2 }])).toEqual({ files: [file(1), file(2), file(3)], count: 3 })
    expect(artworkOfGroup([{ artworkCount: 2 }, { artworkCount: 1 }])).toEqual({ files: [], count: 3 })
    expect(artworkOfGroup([{ artwork: [], artworkCount: 0 }])).toEqual({ files: [], count: 0 })
  })

  it('"Artwork (2)" is a button that opens the files in the docked thread’s viewer (no trip to the Files tab)', () => {
    for (const locale of LOCALES) {
      const html = render(recordScreen as unknown as DesignScreen<unknown>, caseOf('lines-artwork-viewer'), locale)
      expect(html).toContain(locale === 'en' ? 'title="Open the artwork in the viewer"' : 'title="Apri le grafiche nel visualizzatore"')
      expect(html).toContain(locale === 'en' ? 'Artwork (2)' : 'Grafiche (2)')
    }
    const source = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(source).toContain('frame.openFiles?.({ files: artwork.files.map((file) => ({ id: file.fileId, name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes })), fileId: artwork.files[0]!.fileId, returnTo: event.currentTarget })')
  })

  it('a made-to-measure unit names its rider (name · garment, revision) when the read gives it; without the right only "Made to measure"', () => {
    const named = textOf(render(recordScreen as unknown as DesignScreen<unknown>, caseOf('lines-mtm-rider'), 'en'))
    expect(named).toContain('Made to measure')
    expect(named).toContain('Rider: Demo Rider Uno · JACKET, revision 2')
    expect(textOf(render(recordScreen as unknown as DesignScreen<unknown>, caseOf('lines-mtm-rider'), 'it'))).toContain('Pilota: Demo Rider Uno · JACKET, revisione 2')
    const held = textOf(render(recordScreen as unknown as DesignScreen<unknown>, caseOf('lines-mtm-no-right'), 'en'))
    expect(held).toContain('Made to measure')
    expect(held).not.toContain('Rider:')
    expect(held).not.toContain('Demo Rider Uno')
  })

})
// ---- end F-SA-231b

// ---- F-SA-266 (sales page plan N2, N4; picks P2, P9; 10-order-page §2 "Doors legend", §6.4): Discuss and the doors on the order's rows
describe('F-SA-266: what a row discusses — the chip per audience, the office-only rows, the way back', () => {
  const order = { number: 'SO-2026-0142' }
  const words = { yourOrder: 'your order', firstLine: (thing: string) => `About: ${thing}` }
  it('a line: the office\'s number in a note, the customer\'s own words in a reply (no price, no work-order number)', async () => {
    const { discussAboutOf } = await import('./record/dock/discuss')
    expect(discussAboutOf(order, words, { part: 'line 2 · JKT-01 Black', target: { kind: 'SalesOrderLine', id: 'l2' } })).toEqual({ ref: { kind: 'SalesOrderLine', id: 'l2' }, office: 'SO-2026-0142 · line 2 · JKT-01 Black', customer: 'your order · line 2 · JKT-01 Black' })
    expect(discussAboutOf(order, words, { part: 'shipment SH-1', target: { kind: 'Shipment', id: 's1' } }).customer).toBe('your order · shipment SH-1')
  })
  it('office-only rows (work orders, holds, quality, the money rows) and a part with no reference never have customer words', async () => {
    const { discussAboutOf } = await import('./record/dock/discuss')
    expect(discussAboutOf(order, words, { part: 'WO-2026-0311', target: { kind: 'WorkOrder', id: 'w1' }, officeOnly: true }).customer).toBeNull()
    expect(discussAboutOf(order, words, { part: 'deposit', target: { kind: 'DepositRequest', id: 'd1' }, officeOnly: true }).customer).toBeNull()
    expect(discussAboutOf(order, words, { part: 'invoice FT-1', target: { kind: 'Invoice', id: 'i1' }, officeOnly: true }).customer).toBeNull()
    const planned = discussAboutOf(order, words, { part: 'Cut start · 22 Nov', target: null })
    expect(planned).toEqual({ ref: null, office: 'SO-2026-0142 · Cut start · 22 Nov', customer: null, line: 'About: SO-2026-0142 · Cut start · 22 Nov' })
  })
  it('"Show on the page": each kind\'s tab and the row\'s anchor; a kind the page does not draw: nothing', async () => {
    const { aboutPlace, rowAnchor } = await import('./record/dock/discuss')
    expect(aboutPlace({ kind: 'SalesOrderLine', id: 'l2' })).toEqual({ tab: 'lines', anchor: 'about-SalesOrderLine-l2' })
    expect(aboutPlace({ kind: 'Shipment', id: 's1' })?.tab).toBe('shipments')
    expect(aboutPlace({ kind: 'Invoice', id: 'i1' })?.tab).toBe('money')
    expect(aboutPlace({ kind: 'DepositRequest', id: 'd1' })?.tab).toBe('money')
    expect(aboutPlace({ kind: 'OrderGate', id: 'g1' })?.tab).toBe('production')
    expect(aboutPlace({ kind: 'OrderChangeRequest', id: 'r1' })).toEqual({ tab: 'changes', anchor: 'about-OrderChangeRequest-r1' })
    expect(aboutPlace({ kind: 'WorkOrder', id: 'w1' })?.tab).toBe('production')
    expect(aboutPlace({ kind: 'Nonconformance', id: 'n1' })).toBeNull()
    expect(rowAnchor('WorkOrder', 'w1')).toBe('about-WorkOrder-w1')
  })
  it('each tab gives its rows their door and anchor; the office-only ones say so (the sources)', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const lines = read('./record/view/LinesTab.tsx')
    expect(lines).toContain("target={{ kind: 'SalesOrderLine', id: line.id }} />")
    expect(lines).toContain("id={rowAnchor('SalesOrderLine', line.id) /* F-SA-266 */}")
    const production = read('./record/view/ProductionTab.tsx')
    for (const door of ["target={{ kind: 'WorkOrder', id: row.id }} officeOnly", "target={{ kind: 'WorkOrder', id: note.workOrderId }} officeOnly", "target={{ kind: 'WorkOrder', id: entry.workOrderId }} officeOnly"]) expect(production).toContain(door)
    expect(production).toContain("id={rowAnchor('WorkOrder', row.id) /* F-SA-266 */}")
    const money = read('./record/view/MoneyTab.tsx')
    for (const door of ["target={{ kind: 'DepositRequest', id: request.id }} officeOnly", "target={{ kind: 'Invoice', id: invoice.id }} officeOnly", 'target={null} officeOnly']) expect(money).toContain(door)
    const shipments = read('./record/view/ShipmentsTab.tsx')
    expect(shipments).toContain("target={{ kind: 'Shipment', id: row.id }} />")
    const requests = read('./record/view/RequestsSection.tsx')
    expect(requests).toContain("target={{ kind: 'OrderChangeRequest', id: request.id }} />")
    // F-OO-100: Overview's cards are one file each (view/overview/): Next dates and People hold these doors.
    // F-OO-145: a gate's Discuss is an item of its More ▾ now — still by the gate's reference.
    expect(read('./record/view/overview/DatesCard.tsx')).toContain("target: row.gateId ? { kind: 'OrderGate', id: row.gateId } : null")
    expect(read('./record/view/overview/PeopleCard.tsx')).toContain('<FollowersDoor />')
    const changes = read('./record/changes/view/ChangesTab.tsx')
    expect(changes).toContain('<ShowInThreadDoor order={order} at={entry.at} />')
    expect(changes).toContain('id={`change-${entry.id}`}')
    // A thread card jumps back to its row: a replace (no history entry), then the row in view with the focus.
    const page = read('./record/OrderRecord.tsx')
    // op-fx1: F-OP-210 moved it through tabAddress (the dock's scope kept, the narrow view given way to the row).
    expect(page).toContain('router.replace(tabAddress(pathname, window.location.search, place.tab, { narrow: narrowNow(), anchor: place.anchor }), { scroll: false })')
    expect(page).toContain('row.focus({ preventScroll: true })')
    expect(page).toContain('showOnPage={showOnPage /* F-SA-266 */}')
  })
  it('the doors drawn on the page with its conversation, in both languages', () => {
    const caseOf = (id: string) => recordScreen.cases.find((item) => item.id === id)!.model
    const en = render(recordScreen as unknown as DesignScreen<unknown>, caseOf('thread-lines'), 'en')
    expect(en).toMatch(/aria-label="Discuss line \d+ · [^"]* in the thread"/)
    const it = render(recordScreen as unknown as DesignScreen<unknown>, caseOf('thread-lines'), 'it')
    expect(it).toMatch(/aria-label="Discuti riga \d+ · [^"]* nella conversazione"/)
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['yourOrder', 'firstLine', 'line', 'shipment', 'invoice', 'deposit', 'request', 'hold', 'quality', 'revision', 'step']) expect(t(`discuss.${key}`, { thing: 'x', seq: 1, name: 'n', number: 'N', kind: 'k', revision: 2 }), `${locale} ${key}`).not.toBe(`discuss.${key}`)
    }
  })
})
// ---- end F-SA-266

// ---- B-SA-070b (sales page plan R7; #1652's own numbers): the Discuss chip in a reply reads the customer's own order number
describe('B-SA-070b: the Discuss chip to the customer reads "your order 12", the office note keeps SO-…', () => {
  it('the chip\'s words with the order\'s own number; without one (made before it was given): "your order", as before', async () => {
    const { discussAboutOf } = await import('./record/dock/discuss')
    const say = (locale: 'en' | 'it') => createTranslator(locale, messagesFor(locale, ['orders']).orders!)
    for (const [locale, words] of [['en', 'your order 12 · line 2 · JKT-01 Black'], ['it', 'il vostro ordine 12 · line 2 · JKT-01 Black']] as const) {
      const t = say(locale)
      const about = discussAboutOf({ number: 'SO-2026-0142' }, { yourOrder: t('discuss.yourOrderSeq', { seq: 12 }), firstLine: (thing) => t('discuss.firstLine', { thing }) }, { part: 'line 2 · JKT-01 Black', target: { kind: 'SalesOrderLine', id: 'l2' } })
      expect(about.customer).toBe(words)
      expect(about.office).toBe('SO-2026-0142 · line 2 · JKT-01 Black')
    }
    const door = readFileSync(new URL('./record/view/Discuss.tsx', import.meta.url), 'utf8')
    expect(door).toContain("const yourOrder = order.customerSeq ? t('discuss.yourOrderSeq', { seq: order.customerSeq }) : t('discuss.yourOrder')")
  })
  it('the order read and the list row parse the number (absent from an older answer: none)', async () => {
    const { orderRowSchema, orderSchema } = await import('./api')
    expect(orderRowSchema.shape.customerSeq.parse(12)).toBe(12)
    expect(orderRowSchema.shape.customerSeq.parse(undefined)).toBeUndefined()
    expect(orderSchema.shape.customerSeq.parse(null)).toBeNull()
  })
})
// ---- end B-SA-070b

// ---- F-OP-111 (10-order-page §4.6): Split into new orders… — caps, whole lines, the body, refusals by place ----------------------
describe('F-OP-111: Split into new orders — each size capped at what may move, the order keeps the rest, refusals at their place', () => {
  const split = () => import('./model')
  /** The order with line 10's size 48 half on a work order, line 20 closed short or not. */
  const withWork = (base = order('CONFIRMED')) => ({ ...base, lines: base.lines.map((line) => (line.seq === 10 ? { ...line, sizes: line.sizes.map((size) => (size.size === '48' ? { ...size, progress: { ...size.progress, inWorkOrders: 1 } } : size)) } : line)) })
  const lineId = (o: ReturnType<typeof order>, seq: number) => o.lines.find((line) => line.seq === seq)!.id

  it('the lines that may move: size-grid lines not closed short, each size less what work orders make; a fee, a unit or a closed line stays', async () => {
    const { splitLinesOf, splitStays } = await split()
    const o = withWork()
    const lines = splitLinesOf(o)
    expect(lines.map((line) => line.seq)).toEqual([10, 20])
    expect(lines[0]!.sizes.find((size) => size.size === '48')).toEqual({ size: '48', quantity: 2, open: 1 })
    expect(lines[0]!.style).toBe('DEMO-JKT-01')
    // Every piece on work orders: nothing can move (the work orders keep making them for this order).
    expect(splitLinesOf(order('IN_PRODUCTION'))).toEqual([])
    const closed = { ...o, lines: o.lines.map((line) => (line.seq === 20 ? { ...line, closedShort: { quantity: 2, at: null, byId: null, reason: null, reasonCode: null } } : line)) }
    expect(splitLinesOf(closed).map((line) => line.seq)).toEqual([10])
    expect(splitStays(closed)).toBe(1)
    const fee = { ...o, lines: [...o.lines, { ...o.lines[0]!, id: 'fee', seq: 90, kind: 'FEE' }] }
    expect(splitLinesOf(fee).map((line) => line.seq)).toEqual([10, 20])
    expect(splitStays(fee)).toBe(1)
  })

  it('⋯ Edit holds it in words: no right to manage orders, a state that does not split, nothing that may move', async () => {
    const { splitHeld } = await split()
    expect(splitHeld(order('CONFIRMED'), canOf('sales'))).toBeNull()
    // op-fx1: READY splits too — with a piece not on a work order (the demo READY has every piece on one: nothing may move, below).
    expect(splitHeld(withWork(order('READY')), canOf('sales'))).toBeNull()
    expect(splitHeld(order('READY'), canOf('sales'))).toEqual({ key: 'split.held.nothing' })
    expect(splitHeld(order('CONFIRMED'), canOf('manager'))).toEqual({ key: 'held.noManage' })
    for (const status of ['SHIPPED', 'CLOSED', 'CANCELLED', 'PARTLY_SHIPPED'] as const) expect(splitHeld(order(status), canOf('sales')), status).toEqual({ key: 'split.held.state' })
    expect(splitHeld(order('IN_PRODUCTION'), canOf('sales'))).toEqual({ key: 'split.held.nothing' })
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{ id: 'split', label: t('split.action'), disabled: !!splitWait, description: held(splitWait), onSelect: () => actions?.onDialog?.({ kind: 'split' }) }")
    const edit = view.slice(view.indexOf('    edit: ['), view.indexOf('    people: people'))
    expect(edit).toContain("id: 'split'")
  })

  it('the caps hold across the parts: what one part takes, another may not; the grid marks the cell with its room', async () => {
    const { splitLinesOf, splitOver, splitPartOf, splitRoom, splitProblem } = await split()
    const o = withWork()
    const lines = splitLinesOf(o)
    const ten = lineId(o, 10)
    const first = { ...splitPartOf(o), grid: { [ten]: { '48': 1 } } }
    const second = { ...splitPartOf(o), grid: { [ten]: { '48': 1, '50': 2 } } }
    expect(splitRoom(lines[0]!, '48', [first, second], 1)).toBe(0)
    expect(splitOver(lines, [first, second], 1)).toEqual([{ lineId: ten, size: '48', room: 0 }])
    expect(splitOver(lines, [first, second], 0)).toEqual([{ lineId: ten, size: '48', room: 0 }])
    expect(splitProblem({ order: o, parts: [first, second], reason: '', today: TODAY })).toEqual({ key: 'split.held.over' })
    expect(splitProblem({ order: o, parts: [first], reason: '', today: TODAY })).toBeNull()
    expect(splitProblem({ order: o, parts: [first, splitPartOf(o)], reason: '', today: TODAY })).toEqual({ key: 'split.held.empty' })
  })

  it('the order keeps at least one line; a date typed before today and a reason too long hold it (the order\'s own date never does)', async () => {
    const { splitPartOf, splitProblem, SPLIT_LIMITS } = await split()
    const o = order('CONFIRMED')
    const all = { ...splitPartOf(o), grid: Object.fromEntries(o.lines.map((line) => [line.id, Object.fromEntries(line.sizes.map((size) => [size.size!, size.quantity]))])) }
    expect(splitProblem({ order: o, parts: [all], reason: '', today: TODAY })).toEqual({ key: 'amend.held.empty' })
    const some = { ...splitPartOf(o), grid: { [lineId(o, 20)]: { '50': 2, '52': 2, '54': 2 } } }
    expect(splitProblem({ order: o, parts: [{ ...some, promiseDate: '2026-10-01' }], reason: '', today: TODAY })).toEqual({ key: 'issue.promiseDate' })
    expect(splitProblem({ order: o, parts: [{ ...some, requestedDate: '2026-10-01' }], reason: '', today: TODAY })).toEqual({ key: 'issue.requestedDate' })
    const late = { ...o, promiseDate: '2026-10-01' }
    expect(splitProblem({ order: late, parts: [{ ...splitPartOf(late), grid: some.grid }], reason: '', today: TODAY })).toBeNull()
    expect(splitProblem({ order: o, parts: [some], reason: 'x'.repeat(SPLIT_LIMITS.reason + 1), today: TODAY })).toEqual({ key: 'split.problem.reason', params: { count: SPLIT_LIMITS.reason } })
    expect(SPLIT_LIMITS).toEqual({ parts: 20, reason: 500 })
  })

  it('the body: the sizes that move (every piece of a line: it goes whole), and only what differs from the order', async () => {
    const { splitBodyOf, splitPartOf } = await split()
    const o = order('CONFIRMED')
    const twenty = lineId(o, 20)
    const ten = lineId(o, 10)
    const whole = { ...splitPartOf(o), grid: { [twenty]: { '50': 2, '52': 2, '54': 2 } } }
    const some = { ...splitPartOf(o), grid: { [ten]: { '48': 1, '50': 0 } }, shipToAddressId: 'addr-2', customerRef: '  ', promiseDate: '2027-01-10' }
    const body = splitBodyOf(o, [whole, some], '  Two shops  ', o.version)
    expect(body).toEqual({
      version: o.version,
      reason: 'Two shops',
      parts: [
        { lines: [{ lineId: twenty, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }, { size: '54', quantity: 2 }] }] },
        { lines: [{ lineId: ten, sizes: [{ size: '48', quantity: 1 }] }], shipToAddressId: 'addr-2', customerRef: null, promiseDate: '2027-01-10' },
      ],
    })
    expect(splitBodyOf(o, [whole], '', 7)).toEqual({ version: 7, parts: [body.parts[0]] })
  })

  it('refusals at their place (by the path only, never the API\'s English): the part and its line; the split as a whole above', async () => {
    const { splitBodyOf, splitPartOf, splitRefusals } = await split()
    const o = order('CONFIRMED')
    const ten = lineId(o, 10)
    const twenty = lineId(o, 20)
    const body = splitBodyOf(o, [{ ...splitPartOf(o), grid: { [ten]: { '48': 1 } } }, { ...splitPartOf(o), grid: { [twenty]: { '50': 1, '52': 1 } } }], '', o.version)
    const issue = (path: string) => ({ path, message: 'English for the logs.' })
    expect(splitRefusals([issue('body/parts/1/lines/0/sizes')], body, o)).toEqual([{ part: 1, words: { key: 'split.problem.whole', params: { line: 20 } } }])
    expect(splitRefusals([issue('body/parts/1/lines/0/sizes/1/quantity')], body, o)).toEqual([{ part: 1, words: { key: 'split.problem.more', params: { line: 20, size: '52' } } }])
    expect(splitRefusals([issue('body/parts/0/lines/0/sizes/0/size')], body, o)).toEqual([{ part: 0, words: { key: 'split.problem.noSize', params: { line: 10, size: '48' } } }])
    expect(splitRefusals([issue('body/parts/0/lines/0/lineId')], body, o)).toEqual([{ part: 0, words: { key: 'split.problem.stays', params: { line: 10 } } }])
    expect(splitRefusals([issue('body/parts/0/lines')], body, o)).toEqual([{ part: 0, words: { key: 'split.problem.empty' } }])
    expect(splitRefusals([issue('body/parts/1/shipToAddressId')], body, o)).toEqual([{ part: 1, words: { key: 'split.problem.shipTo' } }])
    expect(splitRefusals([issue('body/parts/0/promiseDate'), issue('body/parts/0/requestedDate'), issue('body/parts/0/customerRef')], body, o).map((refusal) => refusal.words.key)).toEqual(['issue.promiseDate', 'issue.requestedDate', 'issue.customerRef'])
    expect(splitRefusals([issue('body/parts')], body, o)).toEqual([{ part: null, words: { key: 'amend.held.empty' } }])
    expect(splitRefusals([issue('body/reason')], body, o)).toEqual([{ part: null, words: { key: 'split.problem.reason', params: { count: 500 } } }])
    expect(splitRefusals([issue('body/lines/0/sizes')], body, o)).toEqual([{ part: null, words: { key: 'split.problem.inWork' } }])
    expect(splitRefusals([issue('body/somewhere')], body, o)).toEqual([{ part: null, words: { key: 'problem.write.invalid' } }])
    // Dotted paths read the same; each refusal said once.
    expect(splitRefusals([issue('parts.1.lines.0.sizes'), issue('body/parts/1/lines/0/sizes')], body, o)).toEqual([{ part: 1, words: { key: 'split.problem.whole', params: { line: 20 } } }])
  })

  it('the page: the dialog by its owner (Lines), the write with the version and one key, refusals kept beside the dialog\'s problem line', () => {
    const dialogs = readFileSync(new URL('./record/view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("case 'split': // F-OP-111\n      return <SplitOrderDialog order={order} model={model} actions={actions} />")
    expect(dialogs.indexOf("case 'split'")).toBeGreaterThan(dialogs.indexOf('// Lines (use-lines-acts).'))
    expect(dialogs.indexOf("case 'split'")).toBeLessThan(dialogs.indexOf('// Money (use-money-acts).'))
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('const body = splitBodyOf(value, parts, reason, value.version)')
    expect(acts).toContain('const answer = await splitOrder(api, orderId, body, key)')
    expect(acts).toContain("if (isApiError(error) && error.kind === 'invalid') setRefusals(splitRefusals(error.issues, body, value))")
    expect(acts).toContain('if (value && mayAddresses) readAddresses(value.partyId)')
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).toContain("return api.post(`${orderPath(orderId)}/split`, { body, schema: splitAnswerSchema, idempotencyKey })")
    const dialog = readFileSync(new URL('./record/view/SplitOrderDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).not.toMatch(/from '[^']*(lib\/api|lib\/session|use-lines-acts)/)
    expect(dialog).toContain("<Link key={entry.id} className=\"fw-so-link\" href={`${model.prefix}/sales/orders/${entry.id}`}>")
  })

  it('the customer\'s delivery addresses a part may ship to: active, SHIP_TO, ours or approved (a waiting or refused one never)', async () => {
    const { listShipToAddresses } = await import('./api')
    const address = (id: string, over: Record<string, unknown> = {}) => ({ id, kinds: ['SHIP_TO'], name: null, line1: 'Via Esempio 1', postalCode: '50100', city: 'Firenze', country: 'IT', status: 'ACTIVE', isDefaultShipTo: false, approval: null, ...over })
    const rows = [address('a1'), address('a2', { approval: { status: 'APPROVED' } }), address('a3', { approval: { status: 'WAITING' } }), address('a4', { approval: { status: 'REFUSED' } }), address('a5', { status: 'ARCHIVED' }), address('a6', { kinds: ['BILL_TO'] })]
    const asked: string[] = []
    const api = { get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => (asked.push(path), options.schema.parse({ party: { addresses: rows } })) } as unknown as Parameters<typeof listShipToAddresses>[0]
    expect((await listShipToAddresses(api, 'p1')).map((row) => row.id)).toEqual(['a1', 'a2'])
    expect(asked).toEqual(['/parties/p1'])
  })

  it('every split word in it + en, the same placeholders, plural pairs; no word names a customer', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const keys = ['split.action', 'split.title', 'split.body', 'split.keeps', 'split.part', 'split.addPart', 'split.removePart', 'split.sizes', 'split.room', 'split.line', 'split.shipTo', 'split.shipToSame', 'split.shipToReading', 'split.shipToHeld', 'split.shipToFailed', 'split.reason', 'split.reasonHint', 'split.open', 'split.notice', 'split.held.state', 'split.held.nothing', 'split.held.empty', 'split.held.over', 'split.held.parts', 'split.problem.stays', 'split.problem.whole', 'split.problem.more', 'split.problem.noSize', 'split.problem.line', 'split.problem.empty', 'split.problem.shipTo', 'split.problem.reason', 'split.problem.inWork']
      for (const key of keys) expect(t(key, { number: 'SO-1', n: 1, room: 2, seq: 10, style: 'S', colour: 'C', count: 2, numbers: 'SO-2', line: 10, size: '48' }), `${locale} ${key}`).not.toBe(key)
      for (const key of ['split.stays', 'split.pieces', 'split.go', 'split.done']) expect(t(key, { count: 2, numbers: 'SO-2, SO-3' }), `${locale} ${key}`).not.toBe(key)
    }
    for (const locale of LOCALES) {
      const words = Object.entries(messagesFor(locale, ['orders']).orders!).filter(([key]) => key.startsWith('split.'))
      expect(words.length, locale).toBeGreaterThan(40)
      for (const [key, text] of words) expect(text, `${locale} ${key}`).not.toMatch(/\{(customer|party|brand)\}/)
    }
  })
})
// ---- end F-OP-111

// ---- F-OP-106 (order page N2; 10-order-page §4.1; review R-4): the "What changes" strip, ONE Apply ------------------------------
describe('F-OP-106: the What changes strip — fed by the preview of THIS draft, the work orders by the reader\'s rights, ONE Apply', () => {
  const production = order('IN_PRODUCTION')
  const black = lineOf(production, 10)
  const words = { en: 'WO-0312 is on hold: lift the hold first, then apply the change.', it: 'WO-0312 è in pausa: togli prima la pausa, poi applica la modifica.' }
  // B-OP-013's plan as the API answers it to Sales: the DRAFT follows (orders.manage), the RELEASED one waits (no workorders.manage).
  const plan = [
    { kind: 'LOWER_TO_ORDER' as const, workOrderId: 'wo-draft', number: 'WO-0311', status: 'DRAFT', route: 'SET_DRAFT_CELLS' as const, cells: [{ lineId: black.id, size: '48', from: 2, to: 1, cut: 0 }], extra: 0, appliesNow: true, held: null, reprint: false },
    { kind: 'LOWER_TO_ORDER' as const, workOrderId: 'wo-released', number: 'WO-0312', status: 'RELEASED', route: 'LOWER_RELEASED' as const, cells: [{ lineId: black.id, size: '50', from: 2, to: 1, cut: 0 }], extra: 0, appliesNow: false, held: words, reprint: true },
  ]
  const draftOfTyped = () => {
    const lines = withCells(draftOf(production), { [black.id]: { '48': 1, '50': 1, '52': 2, '54': 2 } })
    return { lines, customerRef: production.customerRef ?? '', requestedDate: production.requestedDate ?? '' }
  }
  // B-OP-013: the plan rides in the preview's `workOrders` (beside the extra pieces).
  const previewOf = (over: { plan?: unknown[] } = {}) => ({ ...AMEND_PREVIEW, workOrders: { extra: [], needsOutcome: false, words: null, plan: over.plan ?? plan } }) as typeof AMEND_PREVIEW
  const en = createTranslator('en', messagesFor('en', ['orders']).orders!)

  it('a DRAFT work order follows now for Sales, a RELEASED one waits for production — said with the API\'s why; a planner\'s follows', async () => {
    const { amendKeyOf, stripOf, workOrderWords } = await import('./daily-model')
    const draft = draftOfTyped()
    const key = amendKeyOf(draft, production)
    const strip = stripOf({ order: production, review: { phase: 'ready', key, preview: previewOf(), problem: null }, key, local: null, price: true, label: () => null })
    expect(strip.phase).toBe('ready')
    expect(strip.workOrders.map((wo) => [wo.number, wo.now, wo.before, wo.after])).toEqual([
      ['WO-0311', true, 2, 1],
      ['WO-0312', false, 2, 1],
    ])
    expect(strip.workOrders.map((wo) => workOrderWords(wo, en, 'en'))).toEqual([
      'WO-0311 2 → 1 · follows now',
      'WO-0312 2 → 1 · waits for production — decide on this page · WO-0312 is on hold: lift the hold first, then apply the change. · its work sheet is printed again',
    ])
    // The same preview answered to a planner (workorders.manage): the released one follows too, no why.
    const planner = previewOf({ plan: plan.map((entry) => ({ ...entry, appliesNow: true, held: null })) })
    const planned = stripOf({ order: production, review: { phase: 'ready', key, preview: planner, problem: null }, key, local: null, price: false, label: () => null })
    expect(planned.workOrders.every((wo) => wo.now && wo.held === null)).toBe(true)
    // A work order this reader does not reach has no number: "A work order"; a new one and a cancel say so.
    const others = stripOf({ order: production, review: { phase: 'ready', key, preview: previewOf({ plan: [{ ...plan[0]!, number: null }, { ...plan[0]!, kind: 'MAKE_MORE', workOrderId: null, number: null, status: null, route: 'NEW_DRAFT', cells: [{ lineId: black.id, size: '48', from: 0, to: 3, cut: 0 }] }, { ...plan[1]!, route: 'CANCEL_WORK_ORDER', appliesNow: true }] }), problem: null }, key, local: null, price: true, label: () => null })
    expect(others.workOrders.map((wo) => workOrderWords(wo, en, 'en'))).toEqual(['A work order 2 → 1 · follows now', 'A new work order: 3 pieces · follows now', 'WO-0312 cancelled · follows now · its work sheet is printed again'])
    expect(strip.workOrders[0]!.lineIds).toEqual([black.id])
  })

  it('pieces always; the net only with the price grain (never shown without it); re-acceptance is information', async () => {
    const { amendKeyOf, stripOf } = await import('./daily-model')
    const draft = draftOfTyped()
    const key = amendKeyOf(draft, production)
    const ordered = production.lines.reduce((sum, line) => sum + line.quantity, 0)
    const seen = { phase: 'ready' as const, key, preview: previewOf(), problem: null }
    const priced = stripOf({ order: production, review: seen, key, local: null, price: true, label: () => null })
    expect(priced.pieces).toEqual({ before: ordered, after: ordered + 6, delta: 6 })
    expect(priced.net).toEqual({ before: 624000, after: 894000, delta: 270000 })
    expect(priced.reaccept).toBe(true)
    expect(stripOf({ order: production, review: seen, key, local: null, price: false, label: () => null }).net).toBeNull()
    // The view draws the net only with the grain too.
    const view = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{model.can.price && strip.net && <span>{change('edit.strip.net'")
  })

  it('a stale preview is dropped: an answer for another draft never shows (reading until THIS draft\'s comes), nor lands on a newer ask', async () => {
    const { amendKeyOf, stripOf, tookPreview } = await import('./daily-model')
    const draft = draftOfTyped()
    const key = amendKeyOf(draft, production)
    const older = amendKeyOf({ ...draft, lines: draftOf(production) }, production)
    expect(older).not.toBe(key)
    // The strip holds an answer asked for the older draft: it reads "Working out what changes…", never the older numbers.
    const stale = stripOf({ order: production, review: { phase: 'ready', key: older, preview: previewOf(), problem: null }, key, local: null, price: true, label: () => null })
    expect(stale.phase).toBe('reading')
    expect(stale.pieces).toBeNull()
    expect(stale.workOrders).toEqual([])
    // An answer comes back after the draft asked again: it is dropped; the one asked for is taken.
    const asking = { ...draft, review: { phase: 'reading' as const, key, preview: null, problem: null } }
    expect(tookPreview(asking, { phase: 'ready', key: older, preview: previewOf(), problem: null })).toBe(asking)
    expect(tookPreview(asking, { phase: 'ready', key, preview: previewOf(), problem: null })?.review?.phase).toBe('ready')
    expect(tookPreview(null, { phase: 'ready', key, preview: previewOf(), problem: null })).toBeNull()
    // The key follows the body and the order's version (a re-read order asks again).
    expect(amendKeyOf(draft, { ...production, version: production.version + 1 })).not.toBe(key)
  })

  it('Apply waits while it reads, when the read failed, when the API refuses by place, without a reason; the draft\'s own hold first', async () => {
    const { amendKeyOf, stripHeld: heldOf, stripOf } = await import('./daily-model')
    const { AMEND_PREVIEW_PROBLEMS } = await import('./_demo/fixtures')
    // A hold's key (an API-worded hold has none: F-OP-107's outcome).
    const stripHeld = (...args: Parameters<typeof heldOf>) => {
      const held = heldOf(...args)
      return held && 'key' in held ? held : null
    }
    const draft = draftOfTyped()
    const key = amendKeyOf(draft, production)
    const of = (review: Parameters<typeof stripOf>[0]['review'], local: { key: string } | null = null) => stripOf({ order: production, review, key, local, price: true, label: () => 'DEMO-JKT-01 · BLK' })
    expect(stripHeld(of(null), { reason: 'x', busy: false, local: null })?.key).toBe('amend.held.reading')
    expect(stripHeld(of({ phase: 'reading', key, preview: null, problem: null }), { reason: 'x', busy: false, local: null })?.key).toBe('amend.held.reading')
    const failed = of({ phase: 'failed', key, preview: null, problem: { key: 'problem.write.unavailable' } })
    expect(failed.problem).toEqual({ key: 'problem.write.unavailable' })
    expect(stripHeld(failed, { reason: 'x', busy: false, local: null })?.key).toBe('amend.held.failed')
    const refused = of({ phase: 'ready', key, preview: { ...AMEND_PREVIEW_PROBLEMS }, problem: null })
    expect(refused.problems.length).toBeGreaterThan(0)
    expect(stripHeld(refused, { reason: 'x', busy: false, local: null })?.key).toBe('amend.held.problems')
    const ready = of({ phase: 'ready', key, preview: previewOf(), problem: null })
    expect(stripHeld(ready, { reason: '  ', busy: false, local: null })?.key).toBe('amend.held.reason')
    expect(stripHeld(ready, { reason: 'Two more blacks.', busy: false, local: null })).toBeNull()
    expect(stripHeld(ready, { reason: 'Two more blacks.', busy: true, local: null })?.key).toBe('held.busy')
    // Nothing changed yet: nothing is asked (idle), and Apply says why.
    const idle = of(null, { key: 'amend.held.nothing' })
    expect(idle.phase).toBe('idle')
    expect(stripHeld(idle, { reason: 'x', busy: false, local: { key: 'amend.held.nothing' } })?.key).toBe('amend.held.nothing')
  })

  it('the notice after Apply names the work orders that followed and those that wait, and the customer when told', async () => {
    const { appliedNotice } = await import('./daily-model')
    const applied = [{ changeId: 'c1', workOrderId: 'w1', number: 'WO-0311', route: 'SET_DRAFT_CELLS' as const, reprint: false }]
    const waiting = [{ changeId: 'c2', workOrderId: 'w2', number: 'WO-0312', words }, { changeId: 'c3', workOrderId: null, number: null, words }]
    expect(appliedNotice(3, { applied: [], waiting: [] }, null)).toEqual({ key: 'edit.done.plain', params: { revision: 3 } })
    expect(appliedNotice(3, { applied, waiting: [] }, 'Brand Alpha')).toEqual({ key: 'edit.done.changedTold', params: { revision: 3, changed: 'WO-0311', customer: 'Brand Alpha' } })
    expect(appliedNotice(3, { applied, waiting }, null)).toEqual({ key: 'edit.done.both', params: { revision: 3, changed: 'WO-0311', waits: 'WO-0312, WO-…' } })
    const notice = appliedNotice(3, { applied, waiting: waiting.slice(0, 1) }, 'Brand Alpha')
    expect(en(notice.key, notice.params)).toBe('Amendment 3 applied · WO-0311 changed · waiting for production: WO-0312 — decide on this page · Brand Alpha told.')
  })

  it('the page: ONE Apply (no review dialog), the preview 500 ms after the last edit and on blur, one call at a time', () => {
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('const PREVIEW_AFTER_MS = 500')
    expect(acts).toContain('if (!draft || !value || asking.current || draftHeld(draft, value)) return')
    expect(acts).toContain('tookPreview(known, { phase: \'ready\', key, preview, problem: null })')
    expect(acts).not.toContain("setDialog({ kind: 'amendReview' })")
    const view = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(view).toContain('onBlur={() => actions?.onAmendPreview?.()}')
    // op-fx1: F-OP-108 — the one Apply says whether it applies as a priced change (a frozen field), so ⌘↵ passes it too.
    expect(view).toContain('if (!heldText) actions?.onAmendApply?.(asPriced)')
    expect(readFileSync(new URL('./record/view/DailyDialogs.tsx', import.meta.url), 'utf8')).not.toContain('AmendReviewDialog')
  })

  it('every strip word in it + en with the same placeholders; Italian says "Si applica subito — senza approvazione"', async () => {
    const { CATALOGUE, placeholdersOf } = await import('../../../lib/i18n/messages')
    const keys = Object.keys(CATALOGUE.en.orders ?? {}).filter((key) => key.startsWith('edit.'))
    expect(keys.length).toBeGreaterThan(20)
    for (const key of keys) {
      expect(CATALOGUE.it.orders?.[key]?.trim(), `it ${key}`).toBeTruthy()
      expect(placeholdersOf(CATALOGUE.it.orders?.[key] ?? ''), key).toEqual(placeholdersOf(CATALOGUE.en.orders?.[key] ?? ''))
    }
    expect(CATALOGUE.it.orders?.['edit.appliesAtOnce']).toBe('Si applica subito — senza approvazione')
    for (const gone of ['amend.review', 'amend.reviewTitle', 'notice.amended', 'notice.amendedReaccept', 'notice.amendedTold']) expect(CATALOGUE.en.orders?.[gone], gone).toBeUndefined()
  })
})
// ---- end F-OP-106

// ---- F-OP-107 (order page B2; 10-order-page §4.2): floors per cell, the extra-pieces picker, Apply waits for an outcome ----------
describe('F-OP-107: below the cut the strip asks what happens to the extra pieces; Close remaining lines and Cancel the same', () => {
  const production = order('IN_PRODUCTION')
  const black = lineOf(production, 10)
  const chooseWords = { en: 'Choose what happens to the 1 extra piece', it: 'Scegli cosa fare del 1 pezzo in più' } // op-fx3: the API's words for one piece (CHANGE_WORDS.chooseExtra)
  const extra = { extra: [{ workOrderSizeId: 'ws-1', salesOrderLineId: black.id, size: '48', count: 1, words: { en: 'Extra pieces: 1 48 already cut', it: 'Pezzi in più: 1 48 già tagliati' } }], needsOutcome: true, words: chooseWords, plan: [] }

  it('the strip carries the preview\'s extra pieces; Apply waits for an outcome (the API\'s words) until one is picked, then for the reason', async () => {
    const { amendKeyOf, heldWordsOf, stripHeld, stripOf } = await import('./daily-model')
    const draft = { lines: withCells(draftOf(production), { [black.id]: { '48': 1, '50': 2, '52': 2, '54': 2 } }), customerRef: '', requestedDate: '' }
    const key = amendKeyOf(draft, production)
    const strip = stripOf({ order: production, review: { phase: 'ready', key, preview: { ...AMEND_PREVIEW, workOrders: extra }, problem: null }, key, local: null, price: true, label: () => null })
    expect(strip.extra?.extra).toHaveLength(1)
    const held = stripHeld(strip, { reason: 'Fewer 48.', busy: false, local: null, extraOutcome: null })
    expect(held).toEqual({ words: chooseWords })
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(heldWordsOf(held!, en, 'it')).toBe(chooseWords.it)
    expect(stripHeld(strip, { reason: 'Fewer 48.', busy: false, local: null, extraOutcome: 'LEFTOVER' })).toBeNull()
    expect(stripHeld(strip, { reason: '', busy: false, local: null, extraOutcome: 'LEFTOVER' })).toEqual({ key: 'amend.held.reason' })
    // No extra pieces (or the API says none is needed): nothing waits for an outcome.
    const none = stripOf({ order: production, review: { phase: 'ready', key, preview: { ...AMEND_PREVIEW, workOrders: { extra: [], needsOutcome: false, words: null, plan: [] } }, problem: null }, key, local: null, price: true, label: () => null })
    expect(none.extra).toBeNull()
    expect(stripHeld(none, { reason: 'x', busy: false, local: null, extraOutcome: null })).toBeNull()
  })

  it('the picker: its pieces by order line, the three outcomes in the review window\'s words — charging held without the price grain', async () => {
    const { extraChoicesOf, outcomeHeld } = await import('./daily-model')
    const priced = extraChoicesOf(extra, production, true)
    expect(priced.pieces).toEqual([{ key: 'ws-1', line: 10, words: extra.extra[0]!.words }])
    expect(priced.outcomes.map((option) => [option.outcome, option.held === null])).toEqual([
      ['CHARGE', true],
      ['LEFTOVER', true],
      ['SCRAP', true],
    ])
    expect(priced.outcomes[1]!.words.en).toBe(`Keep as leftover for ${production.party?.legalName}`)
    const unpriced = extraChoicesOf(extra, production, false)
    expect(unpriced.outcomes[0]!.held?.en).toBe('Charging the customer needs the right to see prices')
    // Close remaining lines and Cancel: the same rule (an outcome needed and none picked: their words; else nothing).
    expect(outcomeHeld(extra, null)).toEqual({ words: chooseWords })
    expect(outcomeHeld({ ...extra, words: null }, null)).toEqual({ key: 'edit.held.extra', params: { count: 1 } })
    expect(outcomeHeld(extra, 'SCRAP')).toBeNull()
    expect(outcomeHeld({ ...extra, needsOutcome: false }, null)).toBeNull()
    expect(outcomeHeld(null, null)).toBeNull()
  })

  it('the page: the outcome goes with Apply only while the preview names extra pieces; Close and Cancel ask their preview and send theirs', () => {
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('const extra = (draft.review?.preview?.workOrders?.extra.length ?? 0) > 0 && draft.extraOutcome ? { extraOutcome: draft.extraOutcome } : {}')
    expect(acts).toContain('previewCloseLines(api, orderId, lineIds)')
    expect(acts).toContain('mine === closeSeq.current && setClosePreview(part(answer))')
    const dialogs = readFileSync(new URL('./record/view/DailyDialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs).toContain("askPreview?.(chosenKey === '' ? [] : chosenKey.split(','))")
    expect(dialogs).toContain('preview?.workOrders?.extra.length ? outcome : null)')
    expect(dialogs).toContain('check?.workOrders?.extra.length ? outcome : null)')
    expect(dialogs).toContain("<p className=\"fw-so-hint\">{t('edit.appliesAtOnce')}</p>")
    const editor = readFileSync(new URL('./record/view/LinesEditor.tsx', import.meta.url), 'utf8')
    expect(editor).toContain("FLOOR_TONE: Readonly<Record<CellIssueKind, 'error' | 'warning'>> = Object.freeze({ shipped: 'error', cut: 'warning', inWork: 'warning' })")
  })

  it('each colour line says "Cut 40 · Sewn 32 · Shipped 0" from the production read (a step not counted is left out)', async () => {
    const { lineFiguresOf } = await import('./daily-model')
    const figures = lineFiguresOf([{ lineId: black.id, cut: 40, sewn: 32, shipped: 0, sizes: [] }, { lineId: 'l2', cut: null, sewn: null, shipped: 3, sizes: [] }])
    expect(figures).toEqual({ [black.id]: { cut: 40, sewn: 32, shipped: 0 }, l2: { cut: null, sewn: null, shipped: 3 } })
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['edit.workOrders', 'edit.planNotRead', 'edit.followed.changed', 'edit.followed.waits']) expect(t(key, { numbers: 'WO-0311' }), `${locale} ${key}`).not.toBe(key)
      expect(t('edit.held.extra', { count: 2 }), locale).not.toBe('edit.held.extra')
    }
  })
})
// ---- end F-OP-107

// ---- F-OP-108: a frozen field turns Apply into "Apply as a priced change" with an optional fee (one button, no FrozenOffer step) ----
describe('F-OP-108: a frozen field — Apply as a priced change, its optional fee in the strip; frozen for good holds it', () => {
  const production = order('IN_PRODUCTION')
  const black = lineOf(production, 10)
  const frozen = { ok: false, revision: 4, version: 7, problems: [{ path: 'body/lines/10/SIZE_QUANTITY', message: 'x' }], diff: null, workOrders: null }

  it('priced: Apply is not held by the freeze (the fee, when typed, must be one); blocked: held; no frozen field: no offer', async () => {
    const { amendKeyOf, feeHeld, pricedOfferOf, stripHeld, stripOf } = await import('./daily-model')
    const { FREEZE_CUT: FREEZE, FREEZE_FINISHED } = await import('./depth/demo/fixtures')
    const draft = { lines: withCells(draftOf(production), { [black.id]: { '48': 2, '50': 3, '52': 2, '54': 2 } }), customerRef: '', requestedDate: '' }
    const key = amendKeyOf(draft, production)
    const strip = stripOf({ order: production, review: { phase: 'ready', key, preview: frozen, problem: null }, key, local: null, price: true, label: () => null })
    expect(strip.frozen).toHaveLength(1)
    expect(strip.problems).toEqual([])
    const priced = pricedOfferOf(strip, FREEZE)
    expect(priced).toBe('priced')
    expect(stripHeld(strip, { reason: 'One more 50.', busy: false, local: null, offer: priced, fee: '' })).toBeNull()
    expect(stripHeld(strip, { reason: 'One more 50.', busy: false, local: null, offer: priced, fee: '25,00' })).toBeNull()
    expect(stripHeld(strip, { reason: 'One more 50.', busy: false, local: null, offer: priced, fee: '25,5,0' })).toEqual({ key: 'edit.held.fee' })
    expect(stripHeld(strip, { reason: '', busy: false, local: null, offer: priced, fee: '' })).toEqual({ key: 'amend.held.reason' })
    expect(pricedOfferOf(strip, FREEZE_FINISHED)).toBe('blocked')
    expect(stripHeld(strip, { reason: 'x', busy: false, local: null, offer: 'blocked', fee: '' })).toEqual({ key: 'amend.held.problems' })
    expect(pricedOfferOf({ frozen: [] }, FREEZE)).toBeNull()
    expect([feeHeld(''), feeHeld('0'), feeHeld('12.50')]).toEqual([false, true, false])
  })

  it('the page: one button — Apply relabels and sends the priced change (fee, reason, outcome); the FrozenOffer banner has no button', () => {
    const view = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(view).toContain("t(asPriced ? 'edit.applyPriced' : 'amend.apply')")
    expect(view).toContain('onClick={() => actions?.onAmendApply?.(asPriced)}')
    expect(view).toContain("{model.can.price && (\n            <Field label={d('priced.fee')}")
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('await applyPricedChange(api, orderId, { ...pricedBodyOf({ ...PRICED_EMPTY, fee: draft.fee }, amendBodyOf(draft, value), true), version: value.version, reason, ...extra }, key)')
    const offer = readFileSync(new URL('./changes-depth/view/ChangesDepth.tsx', import.meta.url), 'utf8')
    expect(offer).not.toContain('onPriced')
    expect(offer).not.toContain("d('offer.go')")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['edit.applyPriced', 'edit.held.fee', 'edit.pricedMore']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-108

// ---- F-OP-109: per line in edit mode — Text… (description, note for production) and Remove line (a line in work orders too) -------
describe('F-OP-109: a line\'s text and Remove line in edit mode; a removed line in work orders says which work order loses it', () => {
  const production = order('IN_PRODUCTION')
  const black = lineOf(production, 10)
  const red = lineOf(production, 20)

  it('the draft starts with each line\'s text; only what differs is sent (empty clears it); a new line sends its own when typed', async () => {
    const { textOf } = await import('./daily-model')
    const draft = draftOf(production)
    expect(draft.find((line) => line.lineId === black.id)?.text).toEqual({ description: black.description ?? '', note: black.note ?? '' })
    expect(changeCount(draft, production)).toBe(0)
    const typed = draft.map((line) => (line.lineId === black.id ? { ...line, text: { description: 'Pocket on the left', note: 'Double stitch at the collar' } } : line))
    expect(changeCount(typed, production)).toBe(1)
    expect(amendLines(typed, production)[0]).toMatchObject({ id: black.id, description: 'Pocket on the left', note: 'Double stitch at the collar' })
    // Unchanged text is not sent; a text cleared is sent as null (the API's "blank to null").
    expect(textOf({ text: { description: black.description ?? '', note: black.note ?? '' } }, black)).toEqual({})
    expect(textOf({ text: { description: '   ', note: black.note ?? '' } }, { ...black, description: 'Old words' })).toEqual({ description: null })
    expect(textOf({ text: { description: 'New', note: '' } }, null)).toEqual({ description: 'New' })
    expect(textOf({}, black)).toEqual({})
  })

  it('Remove line: every size to 0 — the line is left out (a line in work orders too: it is closed short by the API, B-OP-014)', async () => {
    const { workOrdersOfLine } = await import('./daily-model')
    const removed = draftOf(production).map((line) => (line.lineId === red.id ? { ...line, sizes: {} } : line))
    expect(amendLines(removed, production).map((input) => ('id' in input ? input.id : null))).toEqual([black.id])
    expect(changeCount(removed, production)).toBe(1)
    const wos = [
      { key: 'w1', number: 'WO-0311', route: 'LOWER_RELEASED' as const, before: 4, after: 0, now: false, held: null, reprint: false, lineIds: [red.id] },
      { key: 'w2', number: 'WO-0312', route: 'SET_DRAFT_CELLS' as const, before: 2, after: 2, now: true, held: null, reprint: false, lineIds: [black.id] },
    ]
    expect(workOrdersOfLine(wos, red.id).map((wo) => wo.number)).toEqual(['WO-0311'])
    expect(workOrdersOfLine(wos, 'none')).toEqual([])
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('edit.line.loses', { numbers: 'WO-0311', count: 1 })).toBe('WO-0311 loses this line')
  })

  it('the editor: Text… and Remove line only in edit mode (Remove held once removed, with words); the colour change stays deferred', () => {
    const editor = readFileSync(new URL('./record/view/LinesEditor.tsx', import.meta.url), 'utf8')
    expect(editor).toContain("{model.mode === 'amend' && <LineActs line={line} model={model} actions={actions} />}")
    expect(editor).toContain("heldReason={removed ? t('edit.line.removed')")
    expect(editor).not.toContain("t('edit.line.colour')")
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain("line.key === key && !line.locked ? { ...line, sizes: {} } : line")
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['edit.line.text', 'edit.line.description', 'edit.line.note', 'edit.line.remove', 'edit.line.removed']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('edit.line.loses', { numbers: 'WO-1, WO-2', count: 2 }), locale).not.toBe('edit.line.loses')
    }
  })
})
// ---- end F-OP-109

// ---- F-OP-121 (order page plan N6): Create shipment… is the band's next step once garments are released and not shipped ----
describe('F-OP-121: Create shipment… in place', () => {
  const ready = (status: 'READY' | 'PARTLY_SHIPPED', released: number, shipped: number) => order(status, { progress: { ...order(status).progress, released, shipped } })
  it('Ready / Partly shipped with released garments not shipped, and shipping.manage → Create shipment…', () => {
    expect(nextStep(ready('READY', 4, 0), canOf('owner'))).toEqual({ kind: 'createShipment', held: null })
    expect(nextStep(ready('PARTLY_SHIPPED', 4, 2), canOf('owner'))).toEqual({ kind: 'createShipment', held: null })
    // Nothing more released than shipped, or no right to make a shipment (Sales): the promise as before.
    expect(nextStep(ready('READY', 2, 2), canOf('owner')).kind).toBe('changePromise')
    expect(nextStep(ready('READY', 4, 0), canOf('sales')).kind).toBe('changePromise')
    expect(nextStep(ready('READY', 4, 0), canOf('sales')).held).toBeNull()
  })
  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['step.createShipment', 'ship.createdDoor']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('ship.created', { number: 'SH-0091' }), locale).toContain('SH-0091')
    }
  })
})
// ---- end F-OP-121

// ---- F-OP-101 (order page N1; 10-order-page §2.4; rule 42): the approver's yes in place ------------------------------------------
describe('F-OP-101: the yes in place — Confirm the order / Refuse… for an approver who did not ask; held for the asker; who decides', () => {
  const OWN = 'You asked for this: nobody approves their own request, the Owner included. Marco Demo can approve it.'
  const STALE = 'It changed since you looked: the request was asked about another version of the record. Ask again.'
  const OTHER = 'This request waits for another approver: it is not addressed to you or to a role you hold over its company.'
  const task = (over: Record<string, unknown> = {}) => ({
    taskId: 't-1',
    kind: 'SALES_ORDER',
    kindLabel: { en: 'Sales order', it: 'Ordine di vendita' },
    requestedAt: '2026-11-18T09:30:00Z',
    requester: { name: 'Luca Prova', me: false },
    approver: { kind: 'ROLE' as const, name: 'Finance', me: false },
    version: 3,
    requireStepUp: false,
    approve: { allowed: true, why: null },
    reject: { allowed: true, why: null },
    withdraw: { allowed: false, why: 'Only the person who asked for this request takes it back.' },
    ...over,
  })
  const caseOf = (id: string) => recordScreen.cases.find((item) => item.id === id)!.model

  it('the door of each open yes: an approver who did not ask decides; the asker is held (rule 42); anybody else reads who decides', async () => {
    const { yesDoorOf } = await import('./depth/model')
    expect(yesDoorOf(task())).toEqual({ kind: 'decide', task: task(), confirmHeld: null, refuseHeld: null })
    // Rule 42: whatever the roles, the asker never decides — not even the no.
    expect(yesDoorOf(task({ requester: { name: 'Giulia Esempio', me: true }, approve: { allowed: false, why: OWN }, reject: { allowed: false, why: OWN } })).kind).toBe('selfAsked')
    expect(yesDoorOf(task({ requester: { name: 'Giulia Esempio', me: true } })).kind).toBe('selfAsked')
    expect(yesDoorOf(task({ approve: { allowed: false, why: OTHER }, reject: { allowed: false, why: OTHER } }))).toMatchObject({ kind: 'whoDecides', who: 'Finance' })
    // W39-02: the seeded fingerprint reads STALE — the yes is held with its words, the no clears it.
    const stale = yesDoorOf(task({ kind: 'SALES_ORDER_CHANGE', approve: { allowed: false, why: STALE } }))
    expect(stale).toMatchObject({ kind: 'decide', confirmHeld: { key: 'approval.refused.STALE' }, refuseHeld: null })
    // A write of the page runs: both held with its words.
    expect(yesDoorOf(task(), true)).toMatchObject({ confirmHeld: { key: 'held.busy' }, refuseHeld: { key: 'held.busy' } })
  })

  it('the engine\'s why is read by its first words, never shown raw; an unknown one reads the general words', async () => {
    const { yesHeldOf, yesRefusalOf } = await import('./depth/model')
    expect(yesRefusalOf(STALE)).toBe('STALE')
    expect(yesRefusalOf(OWN)).toBe('OWN_REQUEST')
    expect(yesRefusalOf(OTHER)).toBe('NOT_APPROVER')
    expect(yesRefusalOf('The record of this request is gone or out of your reach.')).toBe('SUBJECT_GONE')
    expect(yesRefusalOf('This kind of request has no checker yet: it cannot be re-read, so it cannot be approved here.')).toBe('NO_KIND')
    expect(yesRefusalOf(null)).toBeNull()
    expect(yesHeldOf('Something new')).toEqual({ key: 'approval.refused.other' })
  })

  it('the banner decides the order\'s own yes first, then its credit hold\'s; an old change\'s yes is a waiting row, not the banner\'s', async () => {
    const { bannerYesOf, CHANGE_YES_KIND, confirmLabelOf, decidedNoticeOf } = await import('./depth/model')
    const credit = task({ taskId: 't-2', kind: 'CREDIT_OVERRIDE', kindLabel: { en: 'Credit hold', it: 'Blocco fido' } })
    const change = task({ taskId: 't-3', kind: CHANGE_YES_KIND, kindLabel: { en: 'Order change', it: 'Modifica ordine' } })
    expect(bannerYesOf([credit, change, task()]).map((entry) => entry.taskId)).toEqual(['t-1', 't-2'])
    expect(bannerYesOf(undefined)).toEqual([])
    expect(confirmLabelOf(task(), 'en')).toEqual({ key: 'approval.confirm' })
    expect(confirmLabelOf(credit, 'it')).toEqual({ key: 'approval.approveKind', params: { kind: 'Blocco fido' } })
    expect(decidedNoticeOf(task(), 'approve')).toBe('approval.confirmed')
    expect(decidedNoticeOf(credit, 'approve')).toBe('approval.approved')
    expect(decidedNoticeOf(task(), 'reject')).toBe('approval.refusedDone')
  })

  it('Refuse… needs a reason of the list and words (1 to 2000 characters, the engine\'s own rule)', async () => {
    const { refuseProblemOf, REFUSE_WORDS_MAX } = await import('./depth/model')
    expect(refuseProblemOf({ reasonCode: '', words: 'x' })).toEqual({ key: 'approval.no.pickReason' })
    expect(refuseProblemOf({ reasonCode: 'PRICE', words: '   ' })).toEqual({ key: 'approval.no.wordsNeeded' })
    expect(refuseProblemOf({ reasonCode: 'PRICE', words: 'x'.repeat(REFUSE_WORDS_MAX + 1) })).toEqual({ key: 'approval.no.tooLong', params: { max: REFUSE_WORDS_MAX } })
    expect(refuseProblemOf({ reasonCode: 'PRICE', words: 'Below the agreed list.' })).toBeNull()
  })

  it('a refusal of the engine is said in its own words and the order is read again (W39-02\'s yes: STALE)', async () => {
    const { writeProblem } = await import('./model')
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/STALE' }]))).toEqual({ key: 'approval.refused.STALE', reload: true })
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'refusal/OWN_REQUEST' }]))).toEqual({ key: 'approval.refused.OWN_REQUEST', reload: true })
    // F-OP-116: another route's refusal keeps its own words (only the approval engine's codes are said as a yes's).
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'refusal/SOMETHING_NEW' }]))).toEqual({ key: 'problem.write.state', reload: true })
    expect(writeProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'refusal/PRODUCTION_DOES_THIS' }]))).toEqual({ key: 'problem.write.forbidden', reload: false })
    // A plain version move keeps its words.
    expect(writeProblem(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'version' }]))).toEqual({ key: 'problem.write.moved', reload: true })
  })

  it('every approval.* word exists in it and en (office "tu")', async () => {
    const { YES_REFUSALS } = await import('./depth/model')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      const keys = ['approval.confirm', 'approval.refuse', 'approval.selfAsked', 'approval.stepUp', 'approval.confirmed', 'approval.approved', 'approval.refusedDone', 'approval.refuseGo', 'approval.kind', 'approval.askedBy', 'approval.no.reason', 'approval.no.pick', 'approval.no.words', 'approval.no.wordsHint', 'approval.no.pickReason', 'approval.no.wordsNeeded', 'approval.no.reading', 'approval.refused.other', ...[...YES_REFUSALS].map((code) => `approval.refused.${code}`)]
      for (const key of keys) expect(t(key), `${locale} ${key}`).not.toBe(key)
      for (const [key, params] of [['approval.whoDecides', { who: 'Finance' }], ['approval.approveKind', { kind: 'x' }], ['approval.refuseTitle', { number: 'SO-1' }], ['approval.askedByOn', { who: 'x', date: 'y' }], ['approval.no.tooLong', { max: 2000 }]] as const) expect(t(key, params), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['orders']).orders!)
    expect(en('approval.confirm')).toBe('Confirm the order')
    expect(en('approval.selfAsked')).toBe('You asked for this yes: another person decides')
    expect(en('approval.whoDecides', { who: 'Finance' })).toBe('Who decides: Finance')
    const it_ = createTranslator('it', messagesFor('it', ['orders']).orders!)
    expect(it_('approval.confirm')).toBe("Conferma l'ordine")
    expect(it_('approval.selfAsked')).toBe("Hai chiesto tu questo sì: decide un'altra persona")
  })

  it('design cases: the approver sees Confirm the order and Refuse…; the asker sees it held; another reads who decides', () => {
    // F-OO-111: the yes banner steps back on Overview (section 1's yes strip has the same doors: where.vitest): read on Lines, where it stays.
    const onLines = (id: string) => {
      const model = caseOf(id) as unknown as { record: Record<string, unknown> }
      return { ...model, record: { ...model.record, tab: 'lines' } }
    }
    const approver = render(recordScreen as unknown as DesignScreen<unknown>, onLines('f-op-101-approver-yes'), 'en')
    expect(approver).toContain('Confirm the order')
    expect(approver).toContain('Refuse…')
    const asker = render(recordScreen as unknown as DesignScreen<unknown>, onLines('f-op-101-self-asked'), 'en')
    expect(asker).toContain('You asked for this yes: another person decides')
    expect(asker).toContain('Take the request back')
    expect(textOf(render(recordScreen as unknown as DesignScreen<unknown>, onLines('f-op-101-who-decides'), 'it'))).toContain('Chi decide: Finance')
    const other = render(recordScreen as unknown as DesignScreen<unknown>, onLines('f-op-101-who-decides'), 'en')
    expect(other).toContain('Who decides: Finance')
    expect(other).not.toContain('Confirm the order')
    // op-fx1: the Refuse… dialog's own words are read in record/refuse-yes-dialog.vitest.test.ts (a DS dialog never draws on the
    // server: this file draws the page to a string). Here: its case still draws the page with its door, no key on screen.
    const refuse = render(recordScreen as unknown as DesignScreen<unknown>, caseOf('f-op-101-refuse'), 'en')
    expect(refuse).toContain('Refuse…')
  })

  it('the wiring: the engine\'s own routes with the task version, the page\'s step-up, the order read again; the view fetches nothing', () => {
    const acts = readFileSync(new URL('./record/use-band-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain("approveTask(api, { id: task.taskId, version: task.version }, null, key)")
    expect(acts).toContain("rejectTask(api, { id: task.taskId, version: task.version }, reasonCode, words)")
    expect(acts).toContain("if (task.requireStepUp) await stepUp.ensureFresh('approval.stepUp')")
    // The answer is not an order: the one write reads the order again (the band re-reads; a confirmed order moves on).
    expect(acts).toContain('return null')
    const band = readFileSync(new URL('./depth/view/DepthBand.tsx', import.meta.url), 'utf8')
    expect(band).not.toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/home\/approvals\/api'/)
    expect(band).not.toContain('useEffect')
    const container = readFileSync(new URL('./record/OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('stepUp: { ensureFresh, guard }, setDialog /* F-OP-101: the yes in place */')
  })
})
// ---- end F-OP-101

// ---- F-OP-110 (order page N2; 10-order-page §4.5; B-OP-015): Ship to in the edit header ---------------------------------------
describe('F-OP-110: Ship to in the edit header — the customer\'s own delivery addresses, the prepared shipment named, one edit path', () => {
  const value = order('CONFIRMED')
  const draft = (over: Record<string, unknown> = {}) => ({ lines: draftOf(value), customerRef: value.customerRef ?? '', requestedDate: value.requestedDate ?? '', ...over })

  it('the body sends shipToAddressId only when another address is picked; the preview key moves with it; the header counts as changed', async () => {
    const { amendBodyOf: bodyOf, amendKeyOf: keyOf, headerChangedOf } = await import('./daily-model')
    expect(bodyOf(draft(), value)).not.toHaveProperty('shipToAddressId')
    expect(bodyOf(draft({ shipToAddressId: '' }), value)).not.toHaveProperty('shipToAddressId')
    expect(bodyOf(draft({ shipToAddressId: 'addr-2' }), value)).toMatchObject({ shipToAddressId: 'addr-2' })
    expect(keyOf(draft({ shipToAddressId: 'addr-2' }), value)).not.toBe(keyOf(draft(), value))
    expect(headerChangedOf(draft(), value)).toBe(false)
    expect(headerChangedOf(draft({ shipToAddressId: 'addr-2' }), value)).toBe(true)
    // Only the address moved: nothing else changed, yet the draft is not "nothing changed" (the API moves it alone, B-OP-015).
    expect(reviewHeld(draft().lines, value, { changed: headerChangedOf(draft({ shipToAddressId: 'addr-2' }), value) })).toBeNull()
  })

  it('SHIPMENT_PREPARED is said with that shipment; any other ship-to refusal keeps its words', async () => {
    const { issueWords: wordsOf, preparedShipmentOf } = await import('./daily-model')
    const message = "Shipment SHP-2026-0091 is being prepared for the order's address: change it on the shipment first."
    expect(preparedShipmentOf(message)).toBe('SHP-2026-0091')
    expect(preparedShipmentOf('Something else')).toBeNull()
    expect(wordsOf({ path: 'body/shipToAddressId/SHIPMENT_PREPARED', message }, () => null)).toEqual({ key: 'edit.shipToPreparedOf', params: { number: 'SHP-2026-0091' } })
    expect(wordsOf({ path: 'body/shipToAddressId/SHIPMENT_PREPARED', message: 'x' }, () => null)).toEqual({ key: 'edit.shipToPrepared' })
    expect(wordsOf({ path: 'body/shipToAddressId', message: 'Not an active delivery address of this customer.' }, () => null)).toEqual({ key: 'issue.shipTo' })
  })

  it('an address in one line (name · street · postal code town); the order\'s own as written on it', async () => {
    const { addressLineOf } = await import('./daily-model')
    expect(addressLineOf({ name: 'Brand Alpha — Magazzino', line1: 'Via Esempio 1', postalCode: '20100', city: 'Milano' })).toBe('Brand Alpha — Magazzino · Via Esempio 1 · 20100 Milano')
    expect(addressLineOf({ name: null, line1: 'Via Esempio 1', postalCode: '', city: 'Milano' })).toBe('Via Esempio 1 · Milano')
    expect(addressLineOf(null)).toBeNull()
    expect(addressLineOf({})).toBeNull()
  })

  it('the wiring: the addresses are the order\'s customer\'s (parties.view) read with edit mode; ⋯ Change ship-to… opens it with Ship to focused', () => {
    const acts = readFileSync(new URL('./record/use-lines-acts.ts', import.meta.url), 'utf8')
    expect(acts).toContain('listShipToAddresses(api, value.partyId)')
    expect(acts).toContain('addresses: mayAddresses ? PART_LOADING : null')
    expect(acts).toContain('focus?.(SHIP_TO_FIELD_ID)')
    expect(acts).toContain("'addressOnly' in done && done.addressOnly ? { key: 'edit.shipToDone' }")
    const tab = readFileSync(new URL('./record/view/LinesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("<Select id={SHIP_TO_FIELD_ID} value={amend.shipToAddressId ?? ''}")
    const container = readFileSync(new URL('./record/OrderRecord.tsx', import.meta.url), 'utf8')
    expect(container).toContain('focus: (anchor) => setFocusRow({ anchor, at: Date.now() }), // F-OP-110')
    // The list is the API's wall: GET /parties/:id of the order's own customer, active SHIP_TO addresses ours or approved by us.
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).toContain("address.status === 'ACTIVE' && address.kinds.includes('SHIP_TO') && (!address.approval || address.approval.status === 'APPROVED')")
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['edit.shipTo', 'edit.shipToHeld', 'edit.shipToFailed', 'edit.shipToPrepared', 'edit.shipToDone']) expect(t(key), `${locale} ${key}`).not.toBe(key)
      expect(t('edit.shipToKeep', { address: 'x' }), locale).not.toBe('edit.shipToKeep')
      expect(t('edit.shipToPreparedOf', { number: 'SHP-1' }), locale).toContain('SHP-1')
    }
  })
})
// ---- end F-OP-110

// ---- F-OP-117 (order page N1; 10-order-page §6; review R-22): the Changes tab — work-order changes, the Work orders chip, the badges ----
describe('F-OP-117: the Changes tab — work-order changes of this order, the History chip Work orders, the badges from the ONE list', () => {
  const change = (over: Record<string, unknown> = {}) =>
    ({
      id: 'c1',
      status: 'PROPOSED',
      kind: 'LOWER_TO_ORDER',
      partyId: 'p1',
      salesOrder: { id: 'o1', number: 'SO-DEMO-0150' },
      workOrder: { id: 'wo-1', number: 'WO-DEMO-0311', status: 'RELEASED' },
      requestId: null,
      amendmentId: null,
      cells: [{ salesOrderLineId: 'l1', lineSeq: 10, size: 'M', from: 40, to: 28, workOrderSizeId: 's1' }],
      extra: [],
      extraOutcome: null,
      reason: 'x',
      lastError: null,
      proposedBy: null,
      proposedAt: '2026-11-17T09:00:00Z',
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      madeWorkOrder: null,
      version: 1,
      mayDecide: true,
      words: { title: { en: 'x', it: 'x' }, status: { en: 'Waiting', it: 'In attesa' }, cells: 'M 40 → 28' },
      ...over,
    }) as never

  it('the section: waiting first (oldest first), then decided newest first; only this order\'s; the floor told once carried out', async () => {
    const { workOrderChangeRowsOf, floorToldOfChange } = await import('./record/changes/model')
    const list = [
      change({ id: 'applied', status: 'APPLIED', decidedAt: '2026-11-18T10:00:00Z' }),
      change({ id: 'late', proposedAt: '2026-11-18T09:00:00Z' }),
      change({ id: 'early' }),
      change({ id: 'declined', status: 'DECLINED', decidedAt: '2026-11-19T10:00:00Z' }),
      change({ id: 'other-order', salesOrder: { id: 'o2', number: 'SO-2' } }),
    ]
    expect(workOrderChangeRowsOf(list, 'o1').map((entry: { id: string }) => entry.id)).toEqual(['early', 'late', 'declined', 'applied'])
    expect(floorToldOfChange(change({ status: 'APPLIED', decidedAt: '2026-11-18T10:00:00Z' }))).toBe('2026-11-18T10:00:00Z')
    expect(floorToldOfChange(change())).toBeNull()
    expect(floorToldOfChange(change({ status: 'DECLINED', decidedAt: '2026-11-18T10:00:00Z' }))).toBeNull()
  })

  it('History: a decided work-order change is an entry at its decision under the chip Work orders; a waiting one is not history yet', () => {
    const entries = historyOf({ requests: [], changes: [], amendments: null, confirmation: null, workOrderChanges: [change(), change({ id: 'done', status: 'APPLIED', decidedAt: '2026-11-18T10:00:00Z' })] })
    expect(entries.map((entry) => entry.kind)).toEqual(['workOrderChange'])
    expect(entries[0]).toMatchObject({ id: 'woc-done', at: '2026-11-18T10:00:00Z' })
    expect(historyFor(entries, 'workOrders')).toHaveLength(1)
    expect(historyFor(entries, 'amendments')).toHaveLength(0)
  })

  it('the Changes dot: a Still to do row that is this reader\'s, or a yes they decide, waits on them', async () => {
    const { changesDotOf } = await import('./record/overview/model')
    const still = (mayAct: boolean) => ({ kind: 'WORK_ORDER_CHANGE', ref: null, words: { en: 'x', it: 'x' }, since: '2026-11-17T09:00:00Z', waitingOn: 'PLANNER', mayAct, requestId: null })
    expect(changesDotOf({ onUs: [], still: [still(false)] })).toBe(false)
    expect(changesDotOf({ onUs: [], still: [still(true)] })).toBe(true)
    // F-OO-202: the card holds request rows only — an old change's yes is one (the order's own yes and the credit's are holds).
    const yes = (allowed: boolean, me = false) => ({ key: 'YES:t', kind: 'YES', sub: null, ref: null /* F-OP-301 */, on: 'US' as const, since: null, place: 'REQUEST' as const, words: { kind: 'api' as const, words: { en: 'x', it: 'x' } }, door: { kind: 'yes' as const, task: { taskId: 't', kind: 'SALES_ORDER_CHANGE', kindLabel: { en: 'x', it: 'x' }, requestedAt: '2026-11-17T09:00:00Z', requester: { name: 'Luca Prova', me }, approver: { kind: 'ROLE' as const, name: 'Finance', me: false }, version: 1, requireStepUp: false, approve: { allowed, why: null }, reject: { allowed, why: null }, withdraw: { allowed: false, why: null } } } })
    expect(changesDotOf({ onUs: [yes(true)], still: [] })).toBe(true)
    expect(changesDotOf({ onUs: [yes(false)], still: [] })).toBe(false)
    expect(changesDotOf({ onUs: [yes(true, true)], still: [] })).toBe(false)
  })

  it('the wiring: the tabs count Changes from the ONE waiting list (R-22), the section and the chip are drawn, words in it + en', () => {
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const changesCount = waitingCard ? changesBadgeOf(waitingCard) : null')
    expect(view).toContain('tabCountOf(tab, order, { changes: changesCount /* F-OP-117 */, viewInvoices: model.can.viewInvoices /* F-OP-306 */ })')
    const tab = readFileSync(new URL('./record/changes/view/ChangesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('<WorkOrderChanges order={order} model={model} actions={actions} />')
    expect(tab).toContain('workOrderChanges: model.orderChanges?.list?.value ?? null')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['wocs.title', 'wocs.none', 'wocs.newDraft', 'badge.yourTurn', 'changes.history.chips.workOrders']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-117

// ---- F-OP-102 (order page N1; 10-order-page §2.1, §2.2; set A part): the band's primary by state, the ⋯ re-cut ---------------------
describe('F-OP-102: the band primary by state, in place, and the ⋯ re-cut (set A)', () => {
  const yes = (over: Record<string, unknown> = {}) => ({
    taskId: 't-1',
    kind: 'SALES_ORDER',
    kindLabel: { en: 'Sales order', it: 'Ordine di vendita' },
    requestedAt: '2026-11-18T09:30:00Z',
    requester: { name: 'Luca Prova', me: false },
    approver: { kind: 'ROLE' as const, name: 'Finance', me: false },
    version: 1,
    requireStepUp: false,
    approve: { allowed: true, why: null },
    reject: { allowed: true, why: null },
    withdraw: { allowed: false, why: null },
    ...over,
  })

  it('PENDING_APPROVAL: the approver who did not ask confirms the order; the asker and anyone else ask for it / take it back', () => {
    const waiting = (approvals: unknown[]) => ({ ...order('CONFIRMED', { status: 'PENDING_APPROVAL' }), openApprovals: approvals }) as never
    expect(nextStep(waiting([yes()]), canOf('owner'))).toEqual({ kind: 'confirmYes', held: null, taskId: 't-1' })
    // W39-02-like: the yes held with the engine's words (STALE), still the approver's primary.
    expect(nextStep(waiting([yes({ approve: { allowed: false, why: 'It changed since you looked: …' } })]), canOf('owner'))).toMatchObject({ kind: 'confirmYes', held: { key: 'approval.refused.STALE' } })
    // Rule 42: the asker never confirms; nobody else decides it here.
    expect(nextStep(waiting([yes({ requester: { name: 'Giulia Esempio', me: true } })]), canOf('owner'))).toEqual({ kind: 'askYes', held: null })
    expect(nextStep(waiting([yes({ approve: { allowed: false, why: 'This request waits for another approver: …' }, reject: { allowed: false, why: 'x' } })]), canOf('owner')).kind).toBe('askYes')
    // A credit hold's yes is not "Confirm the order" (its banner pair says Approve: <kind>).
    expect(nextStep(waiting([yes({ kind: 'CREDIT_OVERRIDE' })]), canOf('owner')).kind).toBe('askYes')
    expect(nextStep(waiting([]), canOf('manager')).held?.key).toBe('held.noManage')
  })

  it('every other state as before: Confirmed → Make work orders… (held words), in work → Change promise date, shipped → Close order', () => {
    expect(nextStep(order('CONFIRMED'), canOf('owner')).kind).toBe('makeWorkOrders')
    expect(nextStep(order('IN_PRODUCTION'), canOf('owner')).kind).toBe('changePromise')
    // F-OP-121 (set C, merged): ready with released garments and the shipping right is Create shipment…; else Change promise date.
    expect(['changePromise', 'createShipment']).toContain(nextStep(order('READY'), canOf('owner')).kind)
    expect(nextStep(order('DELIVERED', { settled: true }), canOf('owner')).kind).toBe('close')
  })

  it('the ⋯: Make work orders… while in production with lines not in work orders yet; never before or after', async () => {
    const { makeInMenu } = await import('./model')
    expect(makeInMenu(order('IN_PRODUCTION'), 1)).toBe(true)
    expect(makeInMenu(order('IN_PRODUCTION'), 0)).toBe(false)
    expect(makeInMenu(order('CONFIRMED'), 2)).toBe(false) // the primary already
    expect(makeInMenu(order('SHIPPED'), 2)).toBe(false)
  })

  it('the band: one primary in place (no page change), ⌘↵ runs it; the ⋯ items of set A; no re-confirm item (deferred)', () => {
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).not.toContain('?new=1&order=')
    expect(view).toContain("if (step.kind === 'makeWorkOrders') return actions?.makeWorkOrders?.onOpen?.()")
    expect(view).toContain("if (step.kind === 'confirmYes' && step.taskId) return actions?.yes?.onConfirm?.(step.taskId)")
    expect(view).toContain('runPrimary() // F-OP-102: the primary, in place')
    expect(view).toContain("onSelect: () => actions?.onChangeShipTo?.()")
    expect(view).toContain("onSelect: () => frameRef.current?.openDoor?.('owner')")
    expect(view).toContain('planningHref(model.prefix, firstWorkOrder.id)')
    expect(view).not.toMatch(/reconfirm/i)
    // Edit's order: Change the lines · Change ship-to… · Split… · Close remaining lines… · Reopen lines… · (Set priority…, Set season…).
    // F-OL-04: "Amend order" became "Change the lines" (the Lines tab, its first box focused: no edit mode).
    const at = (id: string) => view.indexOf(`id: '${id}'`)
    expect(view).toContain("onSelect: () => actions?.linesTab?.onLand?.({ lineId: null, box: 'first' })")
    expect(view).not.toContain("id: 'amend'")
    expect(at('lines')).toBeLessThan(at('shipTo'))
    expect(at('shipTo')).toBeLessThan(at('split'))
    expect(at('split')).toBeLessThan(at('closeLines'))
    expect(at('closeLines')).toBeLessThan(at('reopenLines'))
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['bandMenu.makeWorkOrders', 'bandMenu.changeShipTo', 'bandMenu.whoAnswers', 'wo.link.planning', 'approval.confirm']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-102

// ---- F-OP-303 (order page walk #6): "Read-only: your role follows orders and changes none." counts every right the page acts on ----
describe('F-OP-303: the read-only banner only for a reader who can change nothing on the order page', () => {
  it('Warehouse (shipping.manage: Create shipment…, Tracking number…, made elsewhere) is not read-only; a follower only is', () => {
    expect(readOnlyOnPage(abilitiesOf(['orders.view', 'shipping.view', 'shipping.manage', 'shipping.ddt.issue']))).toBe(false)
    expect(readOnlyOnPage(abilitiesOf(['orders.view', 'workorders.view', 'invoices.view', 'quotes.view']))).toBe(true)
    // Each acting right alone lifts the banner — the four of before and the ones it forgot.
    for (const permission of ['orders.manage', 'orders.close', 'payments.record', 'invoices.issue', 'invoices.manage', 'workorders.manage', 'shipping.manage', 'quotes.manage']) expect(readOnlyOnPage(abilitiesOf(['orders.view', permission])), permission).toBe(false)
    expect(PAGE_ACT_RIGHTS).toEqual(['manage', 'close', 'recordPayment', 'issueInvoices', 'manageInvoices', 'makeWorkOrders', 'createShipment', 'manageQuotes'])
    // The page's acting rights outside the order abilities: assign the supervisor, a quality hold on a work order.
    expect(readOnlyOnPage(abilitiesOf(['orders.view']), { assignSupervisor: true })).toBe(false)
    expect(readOnlyOnPage(abilitiesOf(['orders.view']), { qualityHold: true })).toBe(false)
    for (const role of Object.keys(ROLES) as Role[]) expect(readOnlyOnPage(abilitiesOf(ROLES[role])), role).toBe(false)
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })')
    expect(view).not.toContain('!model.can.manage && !model.can.close && !model.can.recordPayment && !model.can.makeWorkOrders')
  })
})
// ---- end F-OP-303

// ---- F-OP-311 (oo-walk #10): the band follows the Owner's rule "Read-only sees no buttons" (order overview plan §1) ----
describe('F-OP-311: Read-only sees no next step and no move in the band; everyone else keeps the move, held with its words', () => {
  const readOnly = abilitiesOf(rolePermissions('read_only'))
  it('no next step for Read-only on any order state; the production manager keeps the held one', () => {
    expect(readOnlyOnPage(readOnly)).toBe(true)
    for (const status of ORDER_STATUSES) {
      expect(bandStepOf(order(status), readOnly, true), status).toEqual({ kind: null, held: null })
      expect(bandStepOf(order(status), canOf('manager'), false), status).toEqual(nextStep(order(status), canOf('manager')))
    }
    // The walk's four: Make work orders (Confirmed), Change promise date… (In production), Close order… (Shipped) — held for the
    // production manager with their words, never hidden from a reader who may act on the page.
    expect(bandStepOf(order('CONFIRMED'), canOf('manager'), false).kind).toBe('makeWorkOrders')
    expect(bandStepOf(order('IN_PRODUCTION'), canOf('manager'), false)).toMatchObject({ kind: 'changePromise', held: { key: 'held.noManage' } })
    expect(bandStepOf(order('SHIPPED', { settled: true }), canOf('manager'), false)).toMatchObject({ kind: 'close', held: { key: 'held.noClose' } })
  })
  it('the ⋯ for Read-only keeps only the open doors and the copy that change nothing; no held move, no Cancel', () => {
    const item = (id: string, disabled = false) => ({ id, label: id, disabled })
    const groups = { next: [item('promise', true), item('ready', true)], edit: [item('priority', true)], people: [item('assignSupervisor', true), item('askSupervisor')], goTo: [item('quote'), item('portal', true), item('planning')], copy: [item('copy'), item('copyQuote', true)] }
    const danger = [item('cancel', true)]
    const shown = bandMenuFor(true, groups, danger)
    expect(shown.danger).toEqual([])
    expect(Object.values(shown.groups).flat().map((entry) => entry.id)).toEqual(['quote', 'planning', 'copy'])
    expect([...BAND_LOOK_ITEMS]).toEqual(['quote', 'portal', 'planning', 'copy'])
    // Anyone who may change something on the page keeps every item, held ones with their words.
    expect(bandMenuFor(false, groups, danger)).toEqual({ groups, danger })
  })
  it('drawn: the Read-only band has no primary button; Sales on the same order keeps its held step', () => {
    const caseOf = (id: string) => recordScreen.cases.find((entry) => entry.id === id)!.model
    const primaryOf = (html: string) => {
      const from = html.indexOf('class="fw-rcf-primary"')
      return from < 0 ? '' : html.slice(from, html.indexOf('</span>', from))
    }
    for (const locale of LOCALES) {
      for (const id of ['f-oo-105-read-only', 'f-oo-205-read-only']) expect(primaryOf(render(recordScreen as unknown as DesignScreen<unknown>, caseOf(id), locale)), `${id} ${locale}`).toBe('')
      expect(primaryOf(render(recordScreen as unknown as DesignScreen<unknown>, caseOf('f-oo-105-holds-sales'), locale)), locale).toContain('<button')
    }
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('const step = bandStepOf(order, model.can, readOnly)')
    expect(view).toContain('bandMenuFor(readOnly, groups, cancelItem)')
  })
})
// ---- end F-OP-311

// ---- F-OO-112 (order overview N13, Owner D1; B-OO-002): readyHeld reads the API's markReady — held with the N of M words ------------
describe('F-OO-112: Mark ready waits for quality — readyHeld reads the API\'s markReady (allowed, else the N of M words from the order read)', () => {
  /** The demo order in production (quality released 7 of its 14 pieces) with its actions as the API's own map gives them. */
  const asApi = (value: ReturnType<typeof order>, released: boolean) => ({
    ...value,
    actions: orderActions(value.status, { released, releasedPieces: releasedPiecesOf(value.lines.map((line) => ({ kind: line.kind, rows: line.sizes.map((size) => size.progress) }))) }).map((entry) => ({ action: entry.action, allowed: entry.allowed, needsReason: entry.needsReason, held: entry.held })),
  })
  const inProduction = order('IN_PRODUCTION')

  it('allowed → null; held → the N of M words (the counts from the order read\'s line sizes); the right first; no action → the state words', () => {
    expect(readyHeld(asApi(inProduction, true), canOf('owner'))).toBeNull()
    expect(readyHeld(asApi(inProduction, false), canOf('owner'))).toEqual({ key: 'held.readyQuality', params: { n: 7, m: 14 } })
    // The same counts as the API's own held words (one rule at both ends).
    expect(asApi(inProduction, false).actions.find((entry) => entry.action === 'markReady')?.held).toBe('Quality releases the garments: 7 of 14 released. The order turns Ready by itself when all are.')
    // Without orders.manage the right is said first (as before); a state with no markReady keeps its words.
    expect(readyHeld(asApi(inProduction, false), canOf('manager'))).toEqual({ key: 'held.noManage' })
    expect(readyHeld(asApi(order('READY'), true), canOf('owner'))).toEqual({ key: 'held.readyState' })
    // A size released beyond its order never makes up for another (each size up to what it has to release); a fee line is never counted.
    const lines = inProduction.lines.map((line, index) => (index === 0 ? { ...line, sizes: line.sizes.map((size, n) => ({ ...size, progress: { ...size.progress, released: n === 0 ? 5 : size.progress.released } })) } : line))
    const fee = { ...inProduction.lines[1]!, id: 'fee-line', kind: 'FEE', sizes: [{ size: null, quantity: 1, unitPrice: null, progress: { ...inProduction.lines[1]!.progress, ordered: 1, released: 0 } }] }
    expect(readyHeld({ ...asApi(inProduction, false), lines: [...lines, fee] }, canOf('owner'))).toEqual({ key: 'held.readyQuality', params: { n: 8, m: 14 } })
  })

  it('the words, it + en, are the domain\'s READY_QUALITY_WORDS (the API\'s held words) with the counts', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      expect(t('held.readyQuality', { n: 3, m: 7 }), locale).toBe(READY_QUALITY_WORDS[locale].replace('{n}', '3').replace('{m}', '7'))
    }
    expect(createTranslator('en', messagesFor('en', ['orders']).orders!)('held.readyQuality', { n: 3, m: 7 })).toBe('Quality releases the garments: 3 of 7 released. The order turns Ready by itself when all are.')
    expect(createTranslator('it', messagesFor('it', ['orders']).orders!)('held.readyQuality', { n: 3, m: 7 })).toBe("Il rilascio lo fa la qualità: 3 su 7 rilasciati. L'ordine diventa Pronto da solo quando lo sono tutti.")
    // The dialog no longer says "while quality release is not used" (it is always in use).
    for (const locale of LOCALES) expect(createTranslator(locale, messagesFor(locale, ['orders']).orders!)('ready.body'), locale).not.toMatch(/not used|non si usa/)
  })

  it('drawn: the Overview\'s Mark ready… is held with the counts in both languages; the band\'s ⋯ says a held phrase with its values', () => {
    const held = recordScreen.cases.find((item) => item.id === 'f-oo-112-ready-held')!
    const en = render(recordScreen as unknown as DesignScreen<unknown>, held.model, 'en')
    expect(en).toMatch(/aria-disabled="true"[^>]*aria-description="Quality releases the garments: 7 of 14 released. The order turns Ready by itself when all are."[^>]*>Mark ready…/)
    const it = render(recordScreen as unknown as DesignScreen<unknown>, held.model, 'it')
    expect(it).toContain('Il rilascio lo fa la qualità: 7 su 14 rilasciati.')
    // The catch-up: every piece released, the dialog opens with its reason.
    const dialog = render(recordScreen as unknown as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'ready-dialog')!.model, 'en')
    expect(dialog.length).toBeGreaterThan(200)
    const view = readFileSync(new URL('./record/view/OrderRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('(phrase ? t(phrase.key, phrase.params) : undefined)')
    expect(view).toContain("description: held(readyWait)")
    const rules = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    expect(rules).toContain('export function readyHeld(order: Order, can: OrderAbilities): Phrase | null {')
    expect(rules).toContain("import { releasedPiecesOf } from '@nexus/factory-domain/sales/orders/orders'")
  })
})
// ---- end F-OO-112

// ---- F-OO-142 (order overview §4.3; B-OO-009): the promise dialog's reason list — a code the customer reads, the office's own note ------
describe('F-OO-142: the promise dialog picks a curated reason the customer reads (Italian and English); the note never reaches the customer', () => {
  const promiseCase = (id: string) => recordScreen.cases.find((item) => item.id === id)!.model
  const draw = (id: string, locale: (typeof LOCALES)[number]) => textOf(render(recordScreen as unknown as DesignScreen<unknown>, promiseCase(id), locale)).replace(/\s+/g, ' ')
  const NOTE = 'La pelle nera arriva una settimana dopo.'

  it('the body is { reasonCode, reason } — each only when given (optional since ol-s1), the note trimmed, lineIds only for chosen lines', () => {
    expect(PROMISE_REASON_CODES.every((code) => isPromiseReasonCode(code))).toBe(true)
    for (const no of ['', 'WEATHER', 'material_late', null, undefined]) expect(isPromiseReasonCode(no), String(no)).toBe(false)
    expect(promiseBodyOf({ date: '2026-12-29', reasonCode: 'MATERIAL_LATE', note: `  ${NOTE}  `, lineIds: null }, 4)).toEqual({ version: 4, promiseDate: '2026-12-29', reasonCode: 'MATERIAL_LATE', reason: NOTE })
    expect(promiseBodyOf({ date: '2026-12-29', reasonCode: 'TRANSPORT', note: '   ', lineIds: ['L20'] }, 5)).toEqual({ version: 5, promiseDate: '2026-12-29', reasonCode: 'TRANSPORT', lineIds: ['L20'] })
    // F-OL-04: nothing picked, nothing typed — neither is sent (the server writes its automatic words).
    expect(promiseBodyOf({ date: '2026-12-29', reasonCode: null, note: '', lineIds: null }, 5)).toEqual({ version: 5, promiseDate: '2026-12-29' })
    // What the API stores from it (B-OO-009) reads back as the picked code — never the note.
    const stored = promiseReasonText('MATERIAL_LATE', NOTE)
    expect(stored).toBe(`MATERIAL_LATE: ${NOTE}`)
    expect(promiseReasonOf(stored)).toBe('MATERIAL_LATE')
    // The band's write sends that body (one place), then reads the production read's headline and dates again.
    const band = readFileSync(new URL('./record/use-band-acts.ts', import.meta.url), 'utf8')
    expect(band).toContain('changePromise(api, orderId, promiseBodyOf(promise, version()))')
    expect(band).toContain("input.againProduction?.(['headline', 'dates'])")
    expect(readFileSync(new URL('./record/OrderRecord.tsx', import.meta.url), 'utf8')).toContain('againProduction: production.again')
  })

  it('the preview shows the code\'s words in Italian AND English (the order\'s language first); null before a pick; the note never in it', () => {
    expect(promiseReasonPreview('', 'it')).toBeNull()
    expect(promiseReasonPreview('WEATHER', 'it')).toBeNull()
    expect(promiseReasonPreview('MATERIAL_LATE', 'it')).toEqual([
      { locale: 'it', words: 'Consegna dei materiali in ritardo' },
      { locale: 'en', words: 'Material delivery late' },
    ])
    expect(promiseReasonPreview('YOUR_CHANGE', 'en')).toEqual([
      { locale: 'en', words: PROMISE_REASON_WORDS.YOUR_CHANGE.en },
      { locale: 'it', words: PROMISE_REASON_WORDS.YOUR_CHANGE.it },
    ])
    for (const code of PROMISE_REASON_CODES) expect(promiseReasonPreview(code, 'it')!.map((entry) => entry.words)).toEqual([PROMISE_REASON_WORDS[code].it, PROMISE_REASON_WORDS[code].en])
    // The list: every curated code, in the office's language — the customer's own words (one wording, no synonym), except the one
    // that speaks to the customer (walk follow-up Z01): "Changed at your request" reads as office words in the list.
    const office = (locale: 'en' | 'it') => {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      return (key: string) => t(key)
    }
    expect(promiseReasonChoices('en', office('en'))).toEqual(PROMISE_REASON_CODES.map((code) => ({ value: code, label: code === 'YOUR_CHANGE' ? 'The customer asked for the change' : PROMISE_REASON_WORDS[code].en })))
    expect(promiseReasonChoices('it', office('it')).map((choice) => choice.label)).toEqual(PROMISE_REASON_CODES.map((code) => (code === 'YOUR_CHANGE' ? 'Il cliente ha chiesto la modifica' : PROMISE_REASON_WORDS[code].it)))
    // Never the customer's voice in the office's list ("your", "voi"); the customer's words stay in the preview (above).
    expect(promiseReasonChoices('en', office('en')).map((choice) => choice.label).join(' | ')).not.toMatch(/\byour\b/i)
    expect(promiseReasonChoices('it', office('it')).map((choice) => choice.label).join(' | ')).not.toMatch(/\b(?:voi|vostr[oaie])\b/i)
  })

  it('drawn: "Why (the customer reads it) · optional", the list, "The customer reads:" in Italian and English, "Your note (office only)"; no pick held nothing (F-OL-04)', () => {
    const en = draw('promise-dialog', 'en')
    for (const words of ['Why (the customer reads it)', 'Pick a reason', 'Material delivery late', 'The customer reads:', 'Italian', '“Consegna dei materiali in ritardo”', 'English', '“Material delivery late”', 'Your note (office only)']) expect(en, words).toContain(words)
    const it = draw('promise-dialog', 'it')
    for (const words of ['Perché (lo legge il cliente)', 'Scegli un motivo', 'Il cliente legge:', 'Italiano', 'Inglese', '“Consegna dei materiali in ritardo”', '“Material delivery late”', 'La tua nota (solo ufficio)']) expect(it, words).toContain(words)
    // The note is the office's: in its own field, never in the customer's preview.
    const preview = en.slice(en.indexOf('The customer reads:'), en.indexOf('Your note (office only)'))
    expect(preview).not.toContain(NOTE)
    // Every curated reason is in the list (a <select>, each <option> in office words: walk follow-up Z01).
    const html = render(recordScreen as unknown as DesignScreen<unknown>, promiseCase('promise-dialog'), 'en')
    for (const code of PROMISE_REASON_CODES) expect(html, code).toContain(`<option value="${code}"`)
    expect(html).toMatch(/<option value="YOUR_CHANGE"[^>]*>The customer asked for the change<\/option>/)
    expect(html).not.toContain('Changed at your request')
    // Nothing picked yet: no preview, and Change the date is NOT held for it (F-OL-04: the reason is optional since ol-s1).
    const pick = render(recordScreen as unknown as DesignScreen<unknown>, promiseCase('f-oo-142-promise-pick'), 'en')
    expect(textOf(pick)).not.toContain('The customer reads:')
    const go = pick.slice(pick.lastIndexOf('<button', pick.indexOf('>Change the date</button>')), pick.indexOf('>Change the date</button>'))
    expect(go).not.toContain('aria-description="Pick why"')
    expect(textOf(pick)).toContain('Why (the customer reads it) · optional')
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['promise.why', 'promise.pick', 'promise.customerReads', 'promise.note', 'promise.problem.code']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
    // "Say why" stays for the requested date's own free reason (F-OO-144); the promise says "Pick why".
    expect(createTranslator('en', messagesFor('en', ['orders']).orders!)('promise.problem.code')).toBe('Pick why')
    expect(createTranslator('it', messagesFor('it', ['orders']).orders!)('promise.problem.code')).toBe('Scegli il perché')
  })

  it('one dialog for every door (band, ⋯, Production #dates, Next dates, Decide…): the ONE PromiseDialog sends through the band\'s onPromise', () => {
    const dialogs = readFileSync(new URL('./record/view/Dialogs.tsx', import.meta.url), 'utf8')
    expect(dialogs.match(/function PromiseDialog\(/g)).toHaveLength(1)
    expect(dialogs).toContain('actions?.onPromise?.({ date, reasonCode, note, lineIds: scope === \'lines\' ? lineIds : null })')
    expect(dialogs).toContain('const followUp = followUpOf(model.dialog)')
    for (const name of ['export type CommandDialogModel', 'export type CommandDialogActions', 'export /* F-CP-108 */ function ReadyDialog(', 'export /* F-CP-108 */ function CloseDialog(']) expect(dialogs, name).toContain(name)
  })
})
// ---- end F-OO-142

// ---- F-OO-206 (order overview §6; review F5; Owner D8): ONE count at both ends — the tab badges are the Linked card's numbers ----------
describe('F-OO-206: the tab badges count what the Linked records card counts (orderLinkCountsOf on the chain, live only); no badges anywhere', () => {
  const shipped = order('SHIPPED')
  const wo = (n: number, status: string) => ({ id: `0190f0e2-9191-7000-8000-0000000000${n}`, number: `WO-000${n}`, status, siteId: shipped.chain.workOrders[0]!.siteId, releasedAt: status === 'DRAFT' ? null : shipped.chain.workOrders[0]!.releasedAt })
  const sh = (n: number, status: string, ddt: { number: string; date: string } | null) => ({ ...shipped.chain.shipments[0]!, id: `0190f0e2-8181-7000-8000-0000000000${n}`, number: `SH-2026-00${n}`, status, ddt })
  const inv = (n: number, docType: string, status: string) => ({ id: `0190f0e2-2121-7000-8000-0000000000${n}`, number: status === 'DRAFT' ? null : `FA-2026-000${n}`, docType, status, issueDate: status === 'DRAFT' ? null : '2026-11-12', depositRequestId: null })
  // Drafts, cancelled work orders and shipments, a credit note (TD04) and a deposit invoice (TD02), open and cancelled deposit requests.
  const value = {
    ...shipped,
    chain: {
      ...shipped.chain,
      workOrders: [wo(31, 'RELEASED'), wo(32, 'DRAFT'), wo(33, 'ON_HOLD'), wo(34, 'COMPLETED'), wo(35, 'CANCELLED')],
      shipments: [sh(51, 'SHIPPED', { number: '101/2026', date: '2026-11-12' }), sh(52, 'CANCELLED', { number: '102/2026', date: '2026-11-13' }), sh(53, 'DELIVERED', null)],
      invoices: [inv(71, 'TD01', 'DRAFT'), inv(72, 'TD01', 'ISSUED'), inv(73, 'TD04', 'ISSUED'), inv(74, 'TD02', 'DELIVERED')],
      depositRequests: [deposit({ status: 'PAID' }), deposit({ id: '0190f0e2-3131-7000-8000-000000000002', status: 'OPEN', stepKind: 'BEFORE_SHIPPING' }), deposit({ id: '0190f0e2-3131-7000-8000-000000000003', status: 'CANCELLED' })],
    },
  }
  const card = (viewInvoices = true) => linkedRowsOf({ order: value, prefix: '/w/demo', can: { ...canOf('owner'), viewInvoices }, complaints: null, returns: null, sameQuote: [], shipInPlace: false, readOnly: false })
  const row = (kind: string, viewInvoices = true) => card(viewInvoices).rows.find((entry) => entry.kind === kind)!

  it('drafts, cancelled shipments, TD04, TD02 and cancelled work orders: each badge = the card\'s number (both from orderLinkCountsOf)', () => {
    const counts = orderLinkCountsOf(value.chain)
    // Production: 4 live (the cancelled one is said in words on the card, never counted).
    expect(tabCountOf('production', value)).toBe(4)
    expect(row('workOrders').count).toBe(tabCountOf('production', value))
    expect(row('workOrders').parts.map((part) => part.key)).toContain('linked.wo.cancelled')
    // Shipments: 2 live; the cancelled one (and its DDT) apart.
    expect(tabCountOf('shipments', value)).toBe(2)
    expect(row('shipments').count).toBe(tabCountOf('shipments', value))
    expect(counts.shipments.lastDdt?.number).toBe('101/2026')
    // Money: 3 issued (the credit note and the deposit invoice among them; the draft apart) + 1 open deposit request.
    expect(tabCountOf('money', value)).toBe(counts.invoices.issued + counts.depositRequests.open)
    expect(tabCountOf('money', value)).toBe(4)
    // Walk #8: the credit note and the deposit invoice are said as part of the 3 issued (one count); the draft apart.
    expect(row('invoices').parts).toEqual([
      { key: 'linked.inv.issuedOf', params: { count: 3 }, of: [{ key: 'linked.inv.creditNote', params: { count: 1 } }, { key: 'linked.inv.deposit', params: { count: 1 } }] },
      { key: 'linked.inv.draft', params: { count: 1 } },
    ])
    // Lines and Changes as before; the files and the Overview count nothing here.
    expect(tabCountOf('lines', value)).toBe(value.lines.length)
    expect(tabCountOf('changes', value, { changes: 3 })).toBe(3)
    expect(tabCountOf('overview', value)).toBeNull()
    expect(tabCountOf('files', value)).toBeNull()
  })

  it('F-OP-306 unchanged: without invoices.view Money counts the open deposits alone and the card says the Money tab\'s sentence alone', () => {
    expect(tabCountOf('money', value, { viewInvoices: false })).toBe(1)
    expect(row('invoices', false)).toMatchObject({ state: 'held', count: null, held: { key: 'money.noInvoiceRight' } })
  })

  it('no badges at either end: the web schema drops the field; the tab counts call the one rule; nothing else counts the chain', () => {
    const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
    expect(api).not.toMatch(/\bbadges\b/)
    const rules = readFileSync(new URL('./model.ts', import.meta.url), 'utf8')
    const from = rules.indexOf('export function tabCountOf(')
    const body = rules.slice(from, rules.indexOf('\n}\n', from))
    expect(body).toContain('orderLinkCountsOf(order.chain)')
    expect(body).not.toMatch(/badges|chain\.(?:workOrders|shipments|invoices)\.length/)
    // The read's own `badges` (an older answer) is dropped by the schema, never read.
    expect(Object.keys(orderSchema.shape)).not.toContain('badges')
  })
})
// ---- end F-OO-206

// ---- F-OP-317 (order page walk #22): a line picture's small preview from the order read opens through this app's /api when the
// local store answers it as a path on the API (the walk's 404 at the web origin); a store's absolute address is used as it is ----
describe('F-OP-317: the order read\'s line picture address goes through /api like every other picture read', () => {
  it('a local-store path gets the /api prefix once; an absolute address and no preview stay as they are', async () => {
    const { orderLineSchema } = await import('./api')
    const picture = orderLineSchema.shape.picture
    const at = '2026-11-20T10:00:00.000Z'
    expect(picture.parse({ fileId: 'f1', contentType: 'image/jpeg', small: { url: '/local-files?token=abc.def', expiresAt: at } })?.small?.url).toBe('/api/local-files?token=abc.def')
    expect(picture.parse({ fileId: 'f1', contentType: 'image/jpeg', small: { url: 'https://store.example.com/k?sig=1', expiresAt: at } })?.small?.url).toBe('https://store.example.com/k?sig=1')
    expect(picture.parse({ fileId: 'f1', contentType: 'image/jpeg', small: null })?.small).toBeNull()
    expect(picture.parse(undefined)).toBeUndefined()
  })
})
// ---- end F-OP-317
