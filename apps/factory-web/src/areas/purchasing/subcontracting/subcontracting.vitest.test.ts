import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { KIT_STATES, SUBCONTRACT_ORDER_STATUSES } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { createApiClient, type ApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { LIST_PAGES, listAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { createOrder, findWorkOrders, listOrders, orderCounts, workshopStock } from './api'
import { canFor, OUTSIDE, ORDER_ROWS, order, STOCK, WORK_ORDER_CHOICES, WORKSHOPS } from './demo/fixtures'
import { designScreen as listScreen } from './list/fixtures'
import { defaultPicks, freePieces, NO_NEW_ORDER, newOrderBody, newOrderHeld, newOrderRefusal, workshopOf, type NewOrderDraft } from './list/list-model'
import { stockKey, stockRowsOf } from './list/view/StockSection'
import { actHeld, journeyIndex, ORDER_VIEWS, orderQuery, say, showOf, sizeRun, subcontractCan, TILES, viewFromAddress, viewOf } from './model'
import { designScreen as stockScreen } from './stock/fixtures'

/**
 * Purchasing › Subcontract orders (SCR-128 list, SCR-129 stock at subcontractors; B-W2a-56): the pure rules (the saved
 * views as the API's tile filters, the address, why a band act is held in our words, the size grid), New subcontract
 * order's rules and body, the calls as the API of B-W2a-25 / B-W2a-56 takes them, the record links and the pages, and every
 * design case of the list and the stock drawn in Italian and English with no message key or placeholder left on screen.
 */

const picked = (over: Partial<NewOrderDraft> = {}): NewOrderDraft => ({ ...NO_NEW_ORDER, workOrders: WORK_ORDER_CHOICES, workOrder: WORK_ORDER_CHOICES[0]!, outside: OUTSIDE, picked: defaultPicks(OUTSIDE), ...over })

describe('subcontract orders: the saved views, the address, the tiles', () => {
  it('maps each view to the API’s own filter (a tile and its list agree)', () => {
    expect(orderQuery('open', '')).toEqual({})
    expect(orderQuery('kit', ' sc ')).toEqual({ q: 'sc', kitToSend: true })
    expect(orderQuery('workshop', '')).toEqual({ atWorkshop: true })
    expect(orderQuery('due', '')).toEqual({ dueThisWeek: true })
    expect(orderQuery('late', '', 'c1')).toEqual({ late: true, cursor: 'c1' })
    expect(orderQuery('drafts', '')).toEqual({ status: 'DRAFT' })
    expect(orderQuery('back', '')).toEqual({ status: 'RECEIVED' })
    expect(orderQuery('all', '')).toEqual({ open: false })
    expect(viewOf('late')).toBe('late')
    expect(viewOf('nonsense')).toBe('open')
    expect(viewFromAddress(new URLSearchParams('late=true'))).toBe('late')
    expect(viewFromAddress(new URLSearchParams('status=RECEIVED'))).toBe('back')
    expect(viewFromAddress(new URLSearchParams('view=kit&late=true'))).toBe('kit')
    expect(viewFromAddress(new URLSearchParams(''))).toBe('open')
    expect(showOf('stock')).toBe('stock')
    expect(showOf(null)).toBe('orders')
    expect(TILES.map((tile) => tile.count({ kitToSend: 1, atWorkshops: 2, dueBackThisWeek: 3, late: 4 }))).toEqual([1, 2, 3, 4, null])
  })

  it('reads the roles: the buyer manages with fees, the warehouse sends and receives without money, sales sees nothing', () => {
    expect(canFor('buyer')).toMatchObject({ view: true, manage: true, kit: false, receive: false, cost: true, workOrders: false })
    expect(canFor('warehouse')).toMatchObject({ view: true, manage: false, kit: true, receive: true, ddtIssue: true, cost: false, workOrders: true })
    expect(canFor('planner')).toMatchObject({ view: true, manage: false, kit: false, cost: false })
    expect(canFor('readOnly')).toMatchObject({ view: true, manage: false, kit: false, receive: false })
    expect(canFor('sales').view).toBe(false)
    expect(subcontractCan([])).toMatchObject({ view: false, cost: false })
  })

  it('says why a band act is held from the record’s facts (never the API’s English), the permission first', () => {
    const buyer = canFor('buyer')
    const warehouse = canFor('warehouse')
    expect(actHeld(order('DRAFT'), 'issue', buyer)).toBeNull()
    expect(actHeld(order('DRAFT'), 'issue', warehouse)).toEqual({ key: 'held.permission', params: { permission: 'purchasing.subcontract.manage' } })
    const free = order('DRAFT', { actions: { ...order('DRAFT').actions, issue: 'Line 20 (TAS) has no fee per piece: type it before the order goes to the workshop.' } })
    free.operations[1] = { ...free.operations[1]!, pricePerPiece: '0.000000' }
    expect(actHeld(free, 'issue', buyer)).toEqual({ key: 'held.issue.noFee', params: { line: 20, code: 'TAS' } })
    // Without the cost grain the fee is not seen: the server's sentence is classified, never shown.
    expect(actHeld(free, 'issue', { ...buyer, cost: false })).toEqual({ key: 'held.issue.noFeeHidden' })
    expect(actHeld(order('DRAFT', { actions: { ...order('DRAFT').actions, issue: 'The workshop is not active (blocked or archived): no work is sent to it.' } }), 'issue', buyer)).toEqual({ key: 'held.workshopInactive' })
    expect(actHeld(order('DRAFT'), 'send', warehouse)).toEqual({ key: 'held.send.draft', params: { status: '@statusIn.DRAFT' } })
    expect(actHeld(order('ISSUED'), 'send', warehouse)).toBeNull()
    expect(actHeld(order('AT_WORKSHOP'), 'cancel', buyer)).toEqual({ key: 'held.cancel.state', params: { status: '@statusIn.AT_WORKSHOP' } })
    const issuedOut = order('ISSUED', { actions: { ...order('ISSUED').actions, cancel: 'Part of the kit or the pieces are out already; take them back first.' }, kitLines: order('AT_WORKSHOP').kitLines })
    expect(actHeld(issuedOut, 'cancel', buyer)).toEqual({ key: 'held.out' })
    expect(actHeld(order('ISSUED'), 'receive', warehouse)).toEqual({ key: 'held.receive.nothingOut', params: { status: '@statusIn.ISSUED' } })
    expect(actHeld(order('RECEIVED'), 'close', buyer)).toBeNull()
    const sentAll = order('AT_WORKSHOP', { kitLines: order('AT_WORKSHOP').kitLines.filter((line) => line.status !== 'PLANNED') })
    expect(actHeld(sentAll, 'send', warehouse)).toEqual({ key: 'held.send.nothing' })
    const t = createTranslator('en', messagesFor('en', ['subcontracting']).subcontracting ?? {})
    expect(say(t, { key: 'held.issue.state', params: { status: '@statusIn.ISSUED' } })).toBe('Only a draft goes to the workshop; this order is sent to the workshop.')
  })

  it('walks the journey and draws an operation’s sizes as the size grid reads them', () => {
    expect(SUBCONTRACT_ORDER_STATUSES.map((status) => journeyIndex(order(status)))).toEqual([0, 1, 2, 2, 3, 4, 0])
    const run = sizeRun(order('DRAFT').operations[0]!.sizes)
    expect(run.colours.map((colour) => colour.key)).toEqual(['BLK', 'RED'])
    expect(run.sizes.map((size) => size.key)).toEqual(['48', '50', '52'])
    expect(run.value.RED).toEqual({ '50': 6, '52': 4 })
    expect(run.colours[1]!.offered).toEqual(['50', '52'])
  })
})

describe('New subcontract order', () => {
  it('picks the routing’s outside operations with the pieces still free, and its workshop', () => {
    expect(freePieces(OUTSIDE, OUTSIDE.operations[2]!.id)).toEqual({ garments: 30, left: 18 })
    expect(defaultPicks(OUTSIDE)).toEqual([{ operationId: OUTSIDE.operations[2]!.id, pieces: '18' }])
    expect(workshopOf(picked())?.id).toBe(WORKSHOPS.sewing.id)
    expect(workshopOf(picked({ workshop: { ...WORKSHOPS.finishing } }))?.id).toBe(WORKSHOPS.finishing.id)
  })

  it('holds Create draft with the reason, the permission first', () => {
    const buyer = canFor('buyer')
    expect(newOrderHeld(picked(), canFor('planner'))).toEqual({ key: 'held.permission', params: { permission: 'purchasing.subcontract.manage' } })
    expect(newOrderHeld({ ...NO_NEW_ORDER }, buyer)?.key).toBe('new.held.workOrder')
    expect(newOrderHeld(picked({ outside: null }), buyer)?.key).toBe('held.loading')
    expect(newOrderHeld(picked({ picked: [] }), buyer)?.key).toBe('new.held.operations')
    expect(newOrderHeld(picked({ picked: [{ operationId: OUTSIDE.operations[2]!.id, pieces: '19' }] }), buyer)?.key).toBe('new.held.pieces')
    expect(newOrderHeld(picked({ picked: [{ operationId: OUTSIDE.operations[2]!.id, pieces: '0' }] }), buyer)?.key).toBe('new.held.pieces')
    expect(newOrderHeld(picked({ picked: [{ operationId: OUTSIDE.operations[4]!.id, pieces: '30' }] }), buyer)?.key).toBe('new.held.workshop')
    const noPlace = { ...OUTSIDE, workshops: [{ ...WORKSHOPS.sewing, locations: [] }] }
    expect(newOrderHeld(picked({ outside: noPlace }), buyer)).toEqual({ key: 'new.noLocation', params: { workshop: WORKSHOPS.sewing.name } })
    expect(newOrderHeld(picked(), buyer)).toBeNull()
  })

  it('sends the operations in routing order, pieces only when not every garment, the workshop', () => {
    expect(newOrderBody(picked({ returnDate: '2026-11-27', note: ' doppia ', picked: [{ operationId: OUTSIDE.operations[3]!.id, pieces: '30' }, { operationId: OUTSIDE.operations[2]!.id, pieces: '18' }] }))).toEqual({
      workOrderId: OUTSIDE.workOrder.id,
      partyId: WORKSHOPS.sewing.id,
      expectedBackDate: '2026-11-27',
      note: 'doppia',
      operations: [{ workOrderOperationId: OUTSIDE.operations[2]!.id, pieces: 18 }, { workOrderOperationId: OUTSIDE.operations[3]!.id }],
      planKit: true,
    })
  })

  it('says a refused create in our words: by path, or by the shape of a 409 sentence', () => {
    expect(newOrderRefusal(['body/operations/0/pieces'], 'invalid', '', 'X')?.key).toBe('new.refused.pieces')
    expect(newOrderRefusal(['body/partyId'], 'invalid', '', 'X')?.key).toBe('new.refused.workshop')
    expect(newOrderRefusal([], 'conflict', "The workshop has no stock location on the work order's site yet: create one first", 'Lab')).toEqual({ key: 'new.refused.location', params: { workshop: 'Lab' } })
    expect(newOrderRefusal([], 'conflict', 'Work order WO-1 is ON_HOLD; work is sent out only for a released or running one.', 'Lab')?.key).toBe('new.refused.workOrder')
    expect(newOrderRefusal([], 'conflict', 'something else', 'Lab')).toBeNull()
  })
})

describe('stock at subcontractors', () => {
  it('filters what was read by workshop and search; a line is its place, material, colour, lot and hide', () => {
    expect(stockRowsOf(STOCK.rows, WORKSHOPS.embroidery.id, '').map((row) => row.item.code)).toEqual(['DEMO-FIL-05'])
    expect(stockRowsOf(STOCK.rows, null, 'lt-demo').length).toBe(1)
    expect(stockRowsOf(STOCK.rows, null, '').length).toBe(3)
    expect(new Set(STOCK.rows.map(stockKey)).size).toBe(3)
  })
})

describe('the calls (B-W2a-25 + B-W2a-56)', () => {
  function recorder(answers: Record<string, unknown>) {
    const calls: { method: string; url: string; body: unknown; key: string | null }[] = []
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined, key: headers.get('idempotency-key') })
      const path = new URL(url, 'http://x').pathname
      const answer = Object.entries(answers).find(([prefix]) => path.endsWith(prefix))?.[1] ?? {}
      return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const api: ApiClient = createApiClient({ baseUrl: '/api', fetch: fetchFn, csrfToken: () => 'csrf' })
    return { api, calls }
  }

  it('lists by a tile’s filter, counts, offers work orders, reads the stock and creates with its key', async () => {
    const { api, calls } = recorder({
      '/purchasing/subcontracting/orders': { items: ORDER_ROWS.slice(0, 1), nextCursor: null },
      '/orders/counts': { kitToSend: 1, atWorkshops: 2, dueBackThisWeek: 0, late: 1 },
      '/purchasing/subcontracting/work-orders': { items: WORK_ORDER_CHOICES },
      '/purchasing/subcontracting/stock': STOCK,
    })
    expect((await listOrders(api, orderQuery('kit', 'lab'))).items).toHaveLength(1)
    expect(calls[0]!.url).toContain('/purchasing/subcontracting/orders?')
    expect(calls[0]!.url).toContain('kitToSend=true')
    expect(calls[0]!.url).toContain('q=lab')
    expect(calls[0]!.url).not.toContain('open=')
    await listOrders(api, orderQuery('all', ''))
    expect(calls[1]!.url).toContain('open=false')
    expect(await orderCounts(api)).toEqual({ kitToSend: 1, atWorkshops: 2, dueBackThisWeek: 0, late: 1 })
    expect((await findWorkOrders(api, ' 0101 ')).map((choice) => choice.number)).toContain('WO-DEMO-0101')
    expect(calls[3]!.url).toContain('q=0101')
    expect((await workshopStock(api)).rows).toHaveLength(3)
    const { api: writer, calls: writes } = recorder({ '/purchasing/subcontracting/orders': { order: order('DRAFT') } })
    await createOrder(writer, newOrderBody(picked()), 'key-1')
    expect(writes[0]).toMatchObject({ method: 'POST', key: 'key-1', body: { workOrderId: OUTSIDE.workOrder.id, planKit: true } })
  })
})

describe('the page in the map', () => {
  it('is built, opens a subcontract order’s record, and takes the list routes', () => {
    expect(OFFICE_PAGES.has('/purchasing/subcontracting')).toBe(true)
    expect(OFFICE_PAGES.has('/purchasing/subcontracting/[id]')).toBe(true)
    expect(OFFICE_PAGES.has('/purchasing/subcontracting/[id]/job-sheet')).toBe(true)
    expect(recordAddress({ type: 'SubcontractOrder', id: 'o1' }, OFFICE_PAGES)).toBe('/purchasing/subcontracting/o1')
    expect(LIST_PAGES['/purchasing/subcontracting/orders']).toBe('/purchasing/subcontracting')
    expect(listAddress('/purchasing/subcontracting/orders', { late: 'true' }, OFFICE_PAGES)).toBe('/purchasing/subcontracting?late=true')
  })
})

const LEFT_KEY = /\b(?:status|statusIn|kit|act|held|problem|common|live|page|tiles|tile|view|list|col|bulk|csv|stock|new|updates)\.[a-zA-Z_]+(?:\.[a-zA-Z_]+)*\b/
const LEFT_PLACEHOLDER = /\{[a-zA-Z]+\}/
/** Permission names are said on purpose ("needs purchasing.subcontract.manage"); domains are not keys. */
const SAID = /\b(?:purchasing\.[a-z.]+|money\.cost|example\.com)\b/g

function render(screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]): string {
  const View = screen.view as ComponentType<{ model: unknown }>
  return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'lists', 'records', 'subcontracting']) }, createElement(View, { model })))
}

describe('every design case draws in both languages with no key left on screen', () => {
  for (const screen of [listScreen, stockScreen] as unknown as DesignScreen<unknown>[]) {
    it(`${screen.screen}: ${screen.cases.length} cases × it, en`, () => {
      for (const item of screen.cases) {
        for (const locale of LOCALES) {
          const html = render(screen, item.model, locale).replace(SAID, '')
          expect(html.length, `${screen.screen}/${item.id}`).toBeGreaterThan(200)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
          expect(html.match(LEFT_PLACEHOLDER)?.[0] ?? null, `${screen.screen}/${item.id} (${locale}) placeholder`).toBeNull()
        }
      }
    })
  }

  it('has words for every status, kit state, view and tile in both languages', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['subcontracting']).subcontracting ?? {})
      const has = (key: string, count?: number) => expect(t(key, count === undefined ? undefined : { count }), `${locale}: ${key}`).not.toBe(key)
      for (const status of SUBCONTRACT_ORDER_STATUSES) {
        has(`status.${status}`)
        has(`statusIn.${status}`)
      }
      for (const state of KIT_STATES) has(`kit.${state}`)
      for (const view of ORDER_VIEWS) has(`view.${view}`)
      for (const tile of TILES) has(`tile.${tile.id}`)
      for (const act of ['issue', 'reopen', 'cancel', 'close', 'send', 'receive']) has(`act.${act}`)
    }
  })
})
