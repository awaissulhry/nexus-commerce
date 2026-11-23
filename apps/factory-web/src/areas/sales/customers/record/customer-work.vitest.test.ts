import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { viewQuery } from '@nexus/factory-domain/views/state'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { rowsQuery, listAddress } from '../../orders/model'
import { sheetAddress } from '../../orders/list/use-orders-sheet'
import { builtInActive, builtInViewsOf, pickBuiltIn, WAITING_US_VIEW, withPreset } from '../../orders/list/view/OrdersListView'
import { marksOf, sourcesTouched, STRIP_GROUPS, tileOf, tilesShown, workAttention, workEntry, WORK_DEFAULT_ROWS, type WorkReads } from './use-customer-work'
import { valueOf } from './work-band' // F-CW-101: the strip became the band (its chips keep the same reads)
import { IN_PRODUCTION_VIEW } from './use-customer-work' // F-CW-101 (S3): the In production view = the started orders' door
import { pickOfRow, WORK_VIEWS, workPreset } from './view/WorkTab'
import { WAITING_SET, WORK_ADDS, WORK_MAX, WORK_MIN, WORK_ORDER, WORK_ROOMS, WORK_SETS, workRoomOf, type WorkRoom } from './view/WorkTab' // F-CW-102: the row's sets by room (F-CP-107 (cp-fx16): its honest widths)
import { orderedByPreset } from '../../orders/list/view/OrdersListView' // F-CW-102
import { DRAFTS_VIEW, NOT_EQUAL_VIEW, workEmptyOf, workViewsOf } from './view/WorkTab' // F-CP-101
import { rowsFromAddress } from '../../orders/model' // F-CP-101: Sales › Orders keeps Open
// ---- F-CP-103 ----
import { OPEN_STATUSES } from '@nexus/factory-domain/sales/orders/orders'
import { OPEN_ORDERS } from '../../../parties/_shared/model'
import { workDoor, workViewCounts } from './use-customer-work'
// ---- end F-CP-103
// ---- F-CP-104 ----
import { rightRef } from '../../../../lib/i18n/rights'
import { workAskAddress } from './use-customer-work'
// ---- end F-CP-104
// F-SA-279: the dock follows the row
import { DOCK_FOLLOW_MS, DOCK_PARAM, DOCK_TABS, dockable, dockAddress, dockFollower, dockKeyOf, dockOnTab, dockTermOf, dockValueOf, draftKeptOf, GENERAL_DOCK, pickOfSummary, scopeOf } from './use-customer-work'
import { lockedEntry } from '../../orders/list/use-orders-sheet' // fx-12
import { writeSearch, type HistoryTarget } from '../../../_shared/record-frame/address' // F-OP-211
// ---- F-CP-141 ----
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { abilitiesOf, boardNarrowOf, extraFromAddress, priceTermOf, withPriceMatch } from '../../orders/model'
import { canOf } from '../../orders/_demo/fixtures'
import { extraChips } from '../../orders/list/view/OrdersListView'
import { MONEY_PRESET, notEqualShown } from './view/WorkTab'
import { NOT_EQUAL_TERMS, notEqualDoor, priceDifferOf, pricesTouched } from './use-customer-work'
import { designScreen } from './fixtures'
// ---- end F-CP-141

/**
 * F-SA-276 (sales page plan N5, N7, N3; picks R5, R9, P10, P17; 11-customer-page §3; 17-review R-1, BW-7): the customer's Work tab —
 * the waiting strip's states (reading "—", a tile left out without its right, 0 is an answer, a failed read says so on its tile
 * only), the address it writes on entry (the default view, the tab a saved view drops, the lock, the old `?tab=orders`), the lock
 * through every path (list, summary, export, saved view, Pin to Today: they all take the address), the four views, the marks the
 * sheet joins by order id, the live sources and the words.
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BETA = '22222222-2222-4222-8222-222222222222'
const BASE = `/w/acme/sales/customers/${ALPHA}`
const params = (query: string) => new URLSearchParams(query)
const board = (tiles: Record<string, number>) => ({ status: 'ready' as const, value: { byStatus: [], tiles: Object.entries(tiles).map(([key, count]) => ({ key, count, filter: {} })) } as never })
const reads = (over: Partial<WorkReads> = {}): WorkReads => ({ board: { status: 'reading' }, requests: { status: 'reading' }, replies: { status: 'reading' }, asks: { status: 'reading' }, tasks: { status: 'reading' }, ...over })

describe('F-SA-276: the address the Work tab writes on entry', () => {
  // F-CP-101: the default view is All orders (`rows=all`, never `status=all`).
  it('no view term: the default view (All orders), the tab and the lock — one write', () => {
    const entry = workEntry(BASE, ALPHA, params(''))!
    const written = new URL(`https://x${entry}`).searchParams
    expect(written.get('tab')).toBe('work')
    expect(written.get('party')).toBe(ALPHA)
    expect(written.get('rows')).toBe(WORK_DEFAULT_ROWS)
    expect(written.has('status')).toBe(false)
  })
  it('a view in the address is kept; a complete address writes nothing', () => {
    const entry = workEntry(BASE, ALPHA, params(`tab=work&party=${ALPHA}&rows=all`))
    expect(entry).toBeNull()
    expect(workEntry(BASE, ALPHA, params(`tab=work&party=${ALPHA}&waiting=us`))).toBeNull()
  })
  it('a saved view replaces the whole query and drops the transient tab: the tab and the lock come back, the view stays', () => {
    const applied = viewQuery(`tab=work&party=${ALPHA}&late=true`)
    expect(applied).not.toContain('tab=')
    const written = new URL(`https://x${workEntry(BASE, ALPHA, params('late=true'))!}`).searchParams
    expect(written.get('tab')).toBe('work')
    expect(written.get('party')).toBe(ALPHA)
    expect(written.get('late')).toBe('true')
    expect(written.has('status')).toBe(false)
  })
  it("another customer's id in the address is overwritten by the page's own (the lock wins)", () => {
    const written = new URL(`https://x${workEntry(BASE, ALPHA, params(`tab=work&party=${BETA}&rows=all`))!}`).searchParams
    expect(written.get('party')).toBe(ALPHA)
  })
  it('the old ?tab=orders opens Work on All orders', () => {
    const written = new URL(`https://x${workEntry(BASE, ALPHA, params('tab=orders'))!}`).searchParams
    expect(written.get('tab')).toBe('work')
    expect(written.get('rows')).toBe('all')
    expect(written.has('status')).toBe(false)
  })
})

describe('F-SA-276: the lock through every path (screen = file)', () => {
  const host = { locked: { party: ALPHA }, keep: ['tab', 'dock'] }
  it('every address the sheet writes keeps the lock and the page\'s tab; the export / saved view / pin read the same terms', () => {
    const address = sheetAddress(BASE, host, params(`tab=work&party=${ALPHA}`), { rows: 'late', q: '', layout: 'list', party: null })
    const query = new URL(`https://x${address}`).searchParams
    expect(query.get('party')).toBe(ALPHA)
    expect(query.get('tab')).toBe('work')
    // The list tools (Export ▾, saved views, Pin to Today) take the address's terms: the lock is among them, the tab is not.
    const kept = new URLSearchParams(viewQuery(query))
    expect(kept.get('party')).toBe(ALPHA)
    expect(kept.has('tab')).toBe(false)
  })
  it('the waiting term travels with the list, the summary, the board and the address', () => {
    expect(rowsQuery('open', '', null, ALPHA, { waiting: 'us' })).toMatchObject({ partyId: ALPHA, open: true, waiting: 'us' })
    expect(listAddress('/x', { rows: 'open', q: '', layout: 'list', party: ALPHA, waiting: 'us' })).toContain('waiting=us')
    const source = readFileSync(new URL('../../../../../../factory-api/src/platform/exports/sources/sales-orders.ts', import.meta.url), 'utf8')
    expect(source).toContain("idTerm(address, ['party', 'partyId'], 'customer')")
    expect(source).toContain('waitingTerm(address)')
  })
})

describe('F-SA-276: the four views (no tabs inside the tab)', () => {
  const orders = createTranslator('en', messagesFor('en', ['orders']).orders!)
  const sheet = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
  // F-CP-101: All orders first.
  // F-CW-101 (S3, S19): In production is the host's view of the STARTED orders (the phase door), no longer the state's rows view.
  const started = [{ id: IN_PRODUCTION_VIEW, label: orders('rows.IN_PRODUCTION') }]
  it('All orders · In production · Waiting on us · Late, in that order; Sales › Orders keeps its own list (no Waiting on us unasked)', () => {
    expect(builtInViewsOf({ customer: null, views: workViewsOf({ price: true }), hostViews: started }, orders, sheet).map((view) => view.label)).toEqual(['All orders', 'In production', 'Waiting on us', 'Late'])
    expect(builtInViewsOf({ customer: null }, orders, sheet).some((view) => view.id === WAITING_US_VIEW)).toBe(false)
    // Sales › Orders keeps the state's own rows view "In production" (the sheet's), and never the host's door.
    expect(builtInViewsOf({ customer: null }, orders, sheet).some((view) => view.id === IN_PRODUCTION_VIEW)).toBe(false)
    expect(builtInViewsOf({ customer: null }, orders, sheet).some((view) => view.id === 'IN_PRODUCTION')).toBe(true)
  })
  it('the active view and a pick: each view stands alone', () => {
    expect(builtInActive({ rows: 'open', kind: null, waiting: 'us' })).toBe(WAITING_US_VIEW)
    expect(builtInActive({ rows: 'IN_PRODUCTION', kind: null, waiting: null })).toBe('IN_PRODUCTION')
    // F-CW-101: the started orders' door shown (`rows=all&phase=IN_PRODUCTION`) ticks the host's In production, not All orders.
    expect(builtInActive({ rows: 'all', kind: null, waiting: null, hostViews: [{ ...started[0]!, active: true }] })).toBe(IN_PRODUCTION_VIEW)
    expect(builtInActive({ rows: 'all', kind: null, waiting: null, hostViews: [{ ...started[0]!, active: false }] })).toBe('all')
    const calls: unknown[][] = []
    const actions = { onRows: (...args: unknown[]) => calls.push(['rows', ...args]), onWaiting: (...args: unknown[]) => calls.push(['waiting', ...args]), onKind: (...args: unknown[]) => calls.push(['kind', ...args]) }
    pickBuiltIn(WAITING_US_VIEW, { waiting: null }, actions)
    pickBuiltIn('late', { waiting: 'us' }, actions)
    pickBuiltIn('all', { waiting: null }, actions)
    expect(calls).toEqual([['waiting', 'us', 'open'], ['waiting', null, 'late'], ['rows', 'all']])
    // F-CW-101: the host's In production goes to the host (it writes the phase door through the sheet's onPhase, one write).
    const host: string[] = []
    pickBuiltIn(IN_PRODUCTION_VIEW, { waiting: null, hostViews: started }, { ...actions, onHostView: (id: string) => host.push(id) })
    expect(host).toEqual([IN_PRODUCTION_VIEW])
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("else if (id === IN_PRODUCTION_VIEW) sheet.actions.onPhase?.('IN_PRODUCTION')")
    expect(tab).toContain("{ id: IN_PRODUCTION_VIEW, label: o('rows.IN_PRODUCTION'), active: startedShown }")
  })
  // F-CW-102 (10-design §1, §3.5; lead settles S4, S31, S39): the row by the ROOM — Picture · Number · Where it is · Promised ·
  // Customer urgency · New messages beside the open thread; Status waits (it is chip 1); wider rooms ADD columns.
  it('the columns of each view: the room\'s set on every view; Waiting on us / Late beside the dock show Waiting on; ⋯ always; Customer and Status never at first', () => {
    const base = workPreset('all', null)
    expect(base.shown).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'newMessages'])
    expect(workPreset('IN_PRODUCTION', null)).toBe(base) // one preset object per room (the sheet's columns are rebuilt only on a real change)
    expect(workPreset('open', null)).toBe(base)
    expect(workPreset('open', 'us').shown).toEqual([...WAITING_SET])
    expect(workPreset('late', null).shown).toEqual(['picture', 'number', 'whereItIs', 'promised', 'waitingOn'])
    expect(workPreset('open', 'us', false, 'wide').shown).toEqual([...WORK_SETS.wide]) // from the wide room the full set holds Waiting on
    for (const room of ['base', 'wide', 'wider', 'widest'] as const) {
      const preset = workPreset('all', null, false, room)
      expect([...preset.shown, ...(preset.wide ?? [])], room).not.toContain('customer')
      expect(preset.shown, room).not.toContain('status')
      expect(preset.shown, room).not.toContain('brand')
      expect(preset.shown.slice(0, 2), room).toEqual(['picture', 'number']) // the picture at every width (P0 item 1)
    }
    expect(withPreset({ colId: 'more' }, base, false).hide).toBeUndefined()
    expect(withPreset({ colId: 'status' }, base, false).hide).toBe(true)
    expect(withPreset({ colId: 'supervisor' }, workPreset('all', null, false, 'widest'), false).hide).toBe(false)
    expect(withPreset({ colId: 'supervisor' }, base, false).hide).toBe(true)
  })
  it('F-CW-102: closing the thread ADDS columns — Waiting on · Deposit, then Shipped, then Priority · Pieces · Ordered · Supervisor', () => {
    expect(WORK_ADDS).toEqual({ wide: ['waitingOn', 'deposit'], wider: ['shipped'], widest: ['priority', 'units', 'orderDate', 'supervisor'] })
    expect(WORK_SETS.wide).toEqual([...WORK_SETS.base, 'waitingOn', 'deposit'])
    expect(WORK_SETS.wider).toEqual([...WORK_SETS.wide, 'shipped'])
    expect(WORK_SETS.widest).toEqual([...WORK_SETS.wider, 'priority', 'units', 'orderDate', 'supervisor'])
    expect([WORK_SETS.base.length, WORK_SETS.wide.length, WORK_SETS.wider.length, WORK_SETS.widest.length]).toEqual([6, 8, 9, 13])
    // The rooms (the tab's own width, never the window's): 865 beside the thread at 1440, 1185 at 1920, 1314 and 1794 with it closed.
    expect([343, 865, 1185, 1314, 1794].map((width) => workRoomOf(width))).toEqual(['base', 'base', 'wide', 'wider', 'widest'])
    expect([workRoomOf(null), workRoomOf(undefined), workRoomOf(WORK_ROOMS.wide - 1), workRoomOf(WORK_ROOMS.wide), workRoomOf(WORK_ROOMS.widest)]).toEqual(['base', 'base', 'base', 'wide', 'widest'])
    // A narrow cell keeps each chip's head (dense); the widest room shows chip 3 whole.
    expect((['base', 'wide', 'wider', 'widest'] as const).map((room) => workPreset('all', null, false, room).dense)).toEqual([true, true, true, false])
  })
  it('F-CW-102: the set\'s own order on screen, its honest widths, and every column but Where it is at its own width (no stretched date)', () => {
    expect(WORK_ORDER).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'priority', 'waitingOn', 'deposit', 'units', 'shipped', 'orderDate', 'supervisor', 'newMessages'])
    // The sheet draws the host's set in the host's order; its other columns follow in their own order; ⋯ stays last.
    const sheet = ['picture', 'number', 'brand', 'status', 'whereItIs', 'newMessages', 'deposit', 'promised', 'waitingOn', 'customerUrgency', 'more'].map((colId) => ({ colId }))
    expect(orderedByPreset(sheet, workPreset('all', null)).map((column) => column.colId)).toEqual(['picture', 'number', 'whereItIs', 'promised', 'customerUrgency', 'waitingOn', 'deposit', 'newMessages', 'brand', 'status', 'more'])
    expect(orderedByPreset(sheet, null).map((column) => column.colId)).toEqual(sheet.map((column) => column.colId))
    // The honest widths: a seed's number, the longest status words (Status in Customise), the picture's 36 px with the cell's padding.
    expect(WORK_MIN).toMatchObject({ picture: 64, number: 150, whereItIs: 220, promised: 108, customerUrgency: 150, newMessages: 52, status: 196 })
    expect(withPreset({ colId: 'number', minWidth: 128 }, workPreset('all', null), false)).toMatchObject({ minWidth: 150, maxWidth: 150, hide: false })
    expect(withPreset({ colId: 'picture', minWidth: 76, maxWidth: 76 }, workPreset('all', null), false)).toMatchObject({ minWidth: 64, maxWidth: 64, hide: false })
    // Where it is takes the room left (the chips): no maximum; Status (ticked in Customise) shows its longest words whole.
    expect(WORK_MAX.whereItIs).toBeUndefined()
    expect(WORK_MAX.status).toBeUndefined()
    expect(withPreset({ colId: 'whereItIs', minWidth: 150 }, workPreset('all', null), false).maxWidth).toBeUndefined()
    expect(withPreset({ colId: 'status', minWidth: 112 }, workPreset('all', null), false).minWidth).toBe(196)
    for (const id of Object.keys(WORK_MAX)) expect(WORK_MAX[id], id).toBe(WORK_MIN[id])
    // Sales › Orders (no preset) keeps the sheet's widths.
    expect(withPreset({ colId: 'status', minWidth: 112 }, null, false).minWidth).toBe(112)
  })
  it('F-CW-102: the budget of every room — select + the set\'s widths + ⋯ fit the room it starts at (no sideways scroll, S4)', () => {
    const view = readFileSync(new URL('../../orders/list/view/OrdersListView.tsx', import.meta.url), 'utf8')
    const more = Number(view.match(/colId: 'more'[^}]*?minWidth: (\d+)/)![1])
    const SELECT = 43
    const need = (ids: readonly string[]) => SELECT + ids.reduce((sum, id) => sum + WORK_MIN[id]!, 0) + more
    // Beside the open thread at 1440 the body is 863 px: the six columns, and the Waiting on us / Late set.
    expect(need(WORK_SETS.base)).toBeLessThanOrEqual(863)
    expect(need(WAITING_SET)).toBeLessThanOrEqual(863)
    // Each wider set fits the width it starts at.
    const rooms: Array<Exclude<WorkRoom, 'base'>> = ['wide', 'wider', 'widest']
    for (const room of rooms) expect(need(WORK_SETS[room]), room).toBeLessThanOrEqual(WORK_ROOMS[room])
    // Every column of every set has its honest width written down (none left to the sheet's smaller default).
    for (const id of new Set([...WORK_SETS.widest, ...WAITING_SET])) expect(WORK_MIN[id], id).toBeGreaterThan(0)
    // The measured rooms land in the sets drawn for them: 1183 (1920 beside the thread), 1312 and 1792 (the thread closed).
    expect(need(WORK_SETS.wide)).toBeLessThanOrEqual(1183)
    expect(need(WORK_SETS.wider)).toBeLessThanOrEqual(1312)
    expect(need(WORK_SETS.widest)).toBeLessThanOrEqual(1792)
  })
  it('a row picks the dock\'s order (its own thread); the tab is drawn by the page (R5)', () => {
    expect(pickOfRow({ id: 'o1', number: 'SO-2026-0142', companyId: 'c1' })).toEqual({ type: 'SalesOrder', id: 'o1', label: 'SO-2026-0142', companyId: 'c1' })
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{tab === 'work' && work}")
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("keep: ['tab', 'dock', COLS_TERM") // F-CP-105: + Work · Money
    expect(tab).toContain('listKey: ORDERS_LIST_KEY')
    expect(tab).toContain('/production/work-orders?party=')
  })
})

describe('F-SA-276: the waiting strip (F-CW-101: the band\'s six chips — the same reads)', () => {
  it('"—" while reading (never 0), 0 is an answer, a capped read says "100+", a failed read only on its tile', () => {
    expect(valueOf(tileOf('late', reads()))).toBe('—')
    expect(valueOf(tileOf('late', reads({ board: board({ late: 0, waitingForDeposit: 2, waitingForCustomer: 0 }) })))).toBe('0')
    expect(valueOf(tileOf('deposit', reads({ board: board({ late: 0, waitingForDeposit: 2, waitingForCustomer: 0 }) })))).toBe('2')
    expect(valueOf(tileOf('replies', reads({ replies: { status: 'ready', value: { rows: [], count: 100, complete: false } } })))).toBe('100+')
    const failed = reads({ requests: { status: 'failed' }, board: board({ late: 1 }) })
    expect(tileOf('requests', failed)).toEqual({ status: 'failed' })
    expect(tileOf('late', failed)).toEqual({ status: 'ready', count: 1, more: false })
    // F-CW-101: a failed read says "!" on its own chip (its press reads it again), never "—" (that is "still reading").
    expect(valueOf(tileOf('requests', failed))).toBe('!')
  })
  it('a tile without its right is left out (no empty "0" tile)', () => {
    expect(tilesShown({ orders: true, workorders: false, threads: false, partners: false })).toEqual(['requests', 'late', 'deposit', 'customer'])
    expect(tilesShown({ orders: false, workorders: false, threads: true, partners: false })).toEqual(['replies', 'tasks'])
    expect(STRIP_GROUPS).toEqual({ us: ['requests', 'replies', 'late'], them: ['deposit', 'customer'], tasks: ['tasks'] })
  })
  it('"Waiting for <customer>" adds our asks, the counter-offers and the changes waiting for their new yes — only the parts the reader reads', () => {
    const all = reads({
      asks: { status: 'ready', value: { items: [{}, {}] as never, complete: true } },
      requests: { status: 'ready', value: { items: [], open: 1, countered: 1 } },
      board: board({ waitingForCustomer: 3 }),
    })
    expect(tileOf('customer', all)).toEqual({ status: 'ready', count: 6, more: false })
    expect(tileOf('customer', { ...all, asks: { status: 'off' } })).toEqual({ status: 'ready', count: 4, more: false })
    expect(tileOf('customer', { ...all, asks: { status: 'reading' } })).toEqual({ status: 'reading' })
  })
  it('the Work tab counts what waits on us: requests to answer + replies waiting on us; null while one is read', () => {
    expect(workAttention(reads())).toEqual({ count: null, attention: false })
    expect(workAttention(reads({ requests: { status: 'ready', value: { items: [], open: 2, countered: 0 } }, replies: { status: 'ready', value: { rows: [], count: 3, complete: true } } }))).toEqual({ count: 5, attention: true })
    expect(workAttention(reads({ requests: { status: 'ready', value: { items: [], open: 0, countered: 4 } }, replies: { status: 'off' } }))).toEqual({ count: 0, attention: false })
  })
})

describe('F-SA-276: the marks the sheet joins by order id, and the live sources (no party id in the browser, BW-7)', () => {
  it('requests waiting on us, oldest first; a reply that waits on an order\'s conversation; other records never mark an order', () => {
    const request = (id: string, orderId: string, askedAt: string, waitingOn: 'US' | 'CUSTOMER') => ({ id, orderId, askedAt, waitingOn }) as never
    const marks = marksOf(
      [request('r2', 'o1', '2026-11-18T09:00:00Z', 'US'), request('r1', 'o1', '2026-11-17T09:00:00Z', 'US'), request('r3', 'o2', '2026-11-17T09:00:00Z', 'CUSTOMER')],
      [{ recordType: 'SalesOrder', recordId: 'o3', waiting: { since: '2026-11-18T07:00:00Z' } }, { recordType: 'Quote', recordId: 'q1', waiting: { since: '2026-11-18T07:00:00Z' } }] as never,
    )
    expect(marks).toEqual({ o1: { requestIds: ['r1', 'r2'] }, o3: { replySince: '2026-11-18T07:00:00Z' } })
  })
  it('each source is read again on its own events', () => {
    expect(sourcesTouched('sales_order.status_changed')).toEqual(['board'])
    expect(sourcesTouched('order_change_request.answered')).toEqual(['requests'])
    expect(sourcesTouched('thread.message_posted')).toEqual(['replies'])
    expect(sourcesTouched('partner_task.created')).toEqual(['asks'])
    expect(sourcesTouched('task.assigned')).toEqual(['tasks'])
    expect(sourcesTouched('stock.moved')).toEqual([])
  })
  it('the sheet swaps values in place by the order ids on screen (never by a party)', () => {
    const hook = readFileSync(new URL('../../orders/list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(hook).toContain('orderIdsOfChange(change.fields).filter((id) => onScreen.current.includes(id))')
    expect(hook).not.toMatch(/change\.fields\.partyId/)
  })
})

describe('F-SA-276: words in both languages', () => {
  it('every key of the strip, the views, the empty and gone lines and the dock pick (no key left)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const keys = [
        'customers.work.strip.label',
        'customers.work.strip.us',
        'customers.work.strip.them',
        'customers.work.strip.tasks',
        ...['requests', 'replies', 'late', 'deposit', 'customer', 'tasks', 'failed'].map((tile) => `customers.work.tile.${tile}`),
        'customers.work.empty',
        'customers.work.emptyAll', // F-CP-101
        'customers.work.showAll',
        'customers.work.gone',
        'customers.work.view.waitingUs',
        'customers.work.dock.label',
        'customers.work.dock.general',
        'customers.work.dock.generalLine',
        'customers.work.dock.recordLine',
        'customers.band.workOrders',
      ]
      for (const key of keys) expect(t(key, { customer: 'Brand Alpha', record: 'SO-1', view: 'x' }), `${locale} ${key}`).not.toBe(key)
      expect(t('customers.work.attention', { count: 2 }), locale).toContain('2')
      const sheet = createTranslator(locale, messagesFor(locale, ['orders-sheet'])['orders-sheet']!)
      for (const key of ['views.waitingUs', 'chips.waitingUs']) expect(sheet(key), `${locale} ${key}`).not.toBe(key)
    }
    // R9: the catalogue's own words ("Tocca a noi").
    const it = createTranslator('it', messagesFor('it', ['parties']).parties!)
    expect(it('customers.work.strip.us')).toBe('Tocca a noi')
  })
})

// ---- F-SA-278 (sales page plan N5, N3; picks R5, P10; Round 4): the strip's two windows — Waiting for <customer> (our asks: the
// portal's requests card as it is; counter-offers; changes waiting for their new yes) and Open tasks; each row picks its record in the dock.
describe('F-SA-278: the strip\'s two windows', () => {
  it('counter-offers are the requests that wait on the customer, oldest first', async () => {
    const { counterOffersOf } = await import('./use-customer-work')
    const request = (id: string, askedAt: string, waitingOn: 'US' | 'CUSTOMER') => ({ id, askedAt, waitingOn }) as never
    expect(counterOffersOf([request('c2', '2026-11-18T09:00:00Z', 'CUSTOMER'), request('u1', '2026-11-16T09:00:00Z', 'US'), request('c1', '2026-11-17T09:00:00Z', 'CUSTOMER')]).map((entry: { id: string }) => entry.id)).toEqual(['c1', 'c2'])
  })
  it('a task row picks its record in the dock; a task on the customer itself picks the customer\'s own thread', async () => {
    const { pickOfTask } = await import('./use-customer-work')
    expect(pickOfTask({ record: { type: 'SalesOrder', id: 'o1', label: 'SO-2026-0142' }, companyId: 'c1' })).toEqual({ type: 'SalesOrder', id: 'o1', label: 'SO-2026-0142', companyId: 'c1' })
    expect(pickOfTask({ record: { type: 'Party', id: ALPHA, label: 'C-0042' }, companyId: null })).toBeNull()
    expect(pickOfTask({ record: null, companyId: null })).toBeNull()
  })
  it('our asks are the existing requests card through its own container (Cancel the request held there without partners.tasks.manage); limits are not read for it', () => {
    const dialog = readFileSync(new URL('./view/WaitingForCustomerDialog.tsx', import.meta.url), 'utf8')
    expect(dialog).toContain("<PortalAccess side=\"customers\" party={party} parts={['requests']} />")
    expect(dialog).toContain('<Modal open') // a centred window, never a drawer
    const view = readFileSync(new URL('../portal/view/PortalAccessView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("const askHeld = !model.can.requests ? heldWords(t, 'right.requests')")
    const portal = readFileSync(new URL('../portal/PortalAccess.tsx', import.meta.url), 'utf8')
    expect(portal).toContain("(parts ?? PORTAL_PARTS).includes('limits')")
    // F-CW-101: the two windows open from the band's chips (the strip's place), the same doors.
    const band = readFileSync(new URL('./view/WorkBand.tsx', import.meta.url), 'utf8')
    expect(band).toContain("(chip.tile === 'customer' || chip.tile === 'tasks') && actions?.onWindow")
  })
  it('every word of the windows in both languages (no key left)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      for (const key of ['customerTitle', 'asked', 'counters', 'reaccept', 'none', 'pickTip', 'tasksTitle', 'tasksNone', 'tasksMore', ...['order', 'what', 'asked', 'ref', 'promised', 'task', 'record', 'for', 'due'].map((col) => `col.${col}`)])
        expect(t(`customers.work.window.${key}`, { customer: 'Brand Alpha', record: 'SO-1' }), `${locale} ${key}`).not.toBe(`customers.work.window.${key}`)
    }
    expect(createTranslator('it', messagesFor('it', ['parties']).parties!)('customers.work.window.asked', { customer: 'Brand Alpha' })).toBe('Abbiamo chiesto a Brand Alpha')
  })
})
// ---- end F-SA-278

// ---- F-SA-277 (sales page plan R5, P18; 17-review R-1): Quotes & incoming — two lists stacked, each its own list locked to the customer,
// its terms its own (in memory: the page's tab stays), a row's click docks its thread (the one DockPick of the page).
describe('F-SA-277: the customer page mounts Quotes & incoming', () => {
  it('the tab draws the two lists the container gives; a row docks its record; the old deals table is gone', () => {
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{tab === 'quotes' && quotesIncoming}")
    expect(view).not.toContain('function DealsTab')
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("<QuotesIncomingTab party={named} onPick={onPick} onFocus={customerDock.onFocus} shown={customerDock.shown} />") // F-SA-279
    const tab = readFileSync(new URL('./QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("import type { DockPick } from './view/WorkTab'")
    expect(tab).toContain("terms: 'memory'")
    expect(tab).toContain("pane: 'host'")
  })
  it('the section words in both languages (the catalogue\'s own titles, R9)', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      for (const key of ['quotes', 'incoming', 'noQuotes', 'noRequests']) expect(t(`customers.quotesTab.${key}`, { customer: 'Brand Alpha' }), `${locale} ${key}`).not.toBe(`customers.quotesTab.${key}`)
      expect(t('customers.quotesTab.quotes'), locale).toBe(t('deals.titleQuotes'))
    }
  })
})
// ---- end F-SA-277

// ---- F-SA-279 (sales page plan N5, N4, N6; picks R5, R9, P9, P11; 11-customer-page §3.7, §9.1): a row drives the dock
describe('F-SA-279: the dock follows the row — the address term `dock=`', () => {
  const ORDER = '11111111-1111-4111-8111-111111111111'
  it('reads a record, All of <customer> or the general conversation; anything else is the general one (no word that it existed)', () => {
    expect(dockTermOf(`SalesOrder.${ORDER}`)).toEqual({ kind: 'record', type: 'SalesOrder', id: ORDER })
    expect(dockTermOf(`Quote.${ORDER}`)).toEqual({ kind: 'record', type: 'Quote', id: ORDER })
    expect(dockTermOf('all')).toEqual({ kind: 'all' })
    expect(dockTermOf(null)).toEqual(GENERAL_DOCK)
    // Work-order notes are never in this dock (Production › Work orders holds them); a hold, an NCR, a change request, a supplier's
    // record, the general one written as a record, a made-up id: the general conversation.
    for (const type of ['WorkOrder', 'QualityHold', 'Nonconformance', 'OrderChangeRequest', 'PurchaseOrder', 'SubcontractOrder', 'Party', 'Nothing']) {
      expect(dockable(type), type).toBe(false)
      expect(dockTermOf(`${type}.${ORDER}`), type).toEqual(GENERAL_DOCK)
    }
    expect(dockTermOf('SalesOrder.not-an-id')).toEqual(GENERAL_DOCK)
    expect(dockTermOf('SalesOrder')).toEqual(GENERAL_DOCK)
    for (const type of ['SalesOrder', 'Quote', 'Inquiry', 'PortalOrderRequest', 'Shipment', 'Project', 'ReturnAuthorisation']) expect(dockable(type), type).toBe(true)
  })
  it('writes the term (a replace keeps every other term; the general one drops it; a line of All of opens at its message)', () => {
    expect(DOCK_PARAM).toBe('dock')
    expect(dockValueOf({ kind: 'record', type: 'SalesOrder', id: ORDER })).toBe(`SalesOrder.${ORDER}`)
    expect(dockValueOf({ kind: 'all' })).toBe('all')
    expect(dockValueOf(GENERAL_DOCK)).toBeNull()
    const base = '/w/DEMO/sales/customers/p1'
    expect(dockAddress(base, '?tab=work&party=p1&status=IN_PRODUCTION', { kind: 'record', type: 'SalesOrder', id: ORDER })).toBe(`${base}?tab=work&party=p1&status=IN_PRODUCTION&dock=SalesOrder.${ORDER}`)
    expect(dockAddress(base, `?tab=work&dock=SalesOrder.${ORDER}&message=m1`, GENERAL_DOCK)).toBe(`${base}?tab=work`)
    expect(dockAddress(base, '?tab=overview', { kind: 'all' })).toBe(`${base}?tab=overview&dock=all`)
    expect(dockAddress(base, '?tab=work', { kind: 'record', type: 'Quote', id: ORDER }, 'm9')).toBe(`${base}?tab=work&dock=Quote.${ORDER}&message=m9`)
    expect(dockAddress(base, '', GENERAL_DOCK)).toBe(base)
  })
  it('a record docks on Work and Quotes & incoming only; All of <customer> on every tab', () => {
    expect(DOCK_TABS).toEqual(['work', 'quotes'])
    const record = { kind: 'record', type: 'SalesOrder', id: ORDER } as const
    expect(dockOnTab('work', record)).toBe(record)
    expect(dockOnTab('quotes', record)).toBe(record)
    expect(dockOnTab('overview', record)).toEqual(GENERAL_DOCK)
    expect(dockOnTab('money', { kind: 'all' })).toEqual({ kind: 'all' })
  })
  it('an address\'s record docks only when the summary read gives it and it is THIS customer\'s', () => {
    const term = { kind: 'record', type: 'SalesOrder', id: ORDER } as const
    expect(pickOfSummary(term, { label: 'SO-2026-0142', party: { id: 'alpha' } }, 'alpha')).toEqual({ type: 'SalesOrder', id: ORDER, label: 'SO-2026-0142', companyId: null })
    // Another customer's order (a person reaching both customers), a record of no customer, a refused read: the general conversation.
    expect(pickOfSummary(term, { label: 'SO-2026-0151', party: { id: 'beta' } }, 'alpha')).toBeNull()
    expect(pickOfSummary(term, { label: 'SO-2026-0151', party: null }, 'alpha')).toBeNull()
    expect(pickOfSummary(term, null, 'alpha')).toBeNull()
    expect(pickOfSummary({ kind: 'all' }, { label: 'x', party: { id: 'alpha' } }, 'alpha')).toBeNull()
  })
  it('the pick shows the record only while the term names the record picked', () => {
    const pick = { type: 'SalesOrder', id: ORDER, label: 'SO-1', companyId: 'c1' }
    expect(scopeOf({ kind: 'record', type: 'SalesOrder', id: ORDER }, pick)).toBe('record')
    expect(scopeOf({ kind: 'record', type: 'SalesOrder', id: ORDER }, null)).toBe('general')
    expect(scopeOf({ kind: 'record', type: 'Quote', id: ORDER }, pick)).toBe('general')
    expect(scopeOf({ kind: 'all' }, pick)).toBe('all')
    expect(scopeOf(GENERAL_DOCK, pick)).toBe('general')
    expect(dockKeyOf(pick)).toBe(`SalesOrder.${ORDER}`)
  })
})

describe('F-SA-279: a click picks at once, the keys after 300 ms of rest', () => {
  afterEach(() => vi.useRealTimers())
  it('a fast run of keys reads ONE conversation: the row the keys stop on, 300 ms later', () => {
    vi.useFakeTimers()
    const applied: string[] = []
    const follow = dockFollower<string>((pick) => applied.push(pick))
    expect(DOCK_FOLLOW_MS).toBe(300)
    follow.soon('row-1')
    vi.advanceTimersByTime(120)
    follow.soon('row-2')
    vi.advanceTimersByTime(120)
    follow.soon('row-3')
    vi.advanceTimersByTime(DOCK_FOLLOW_MS - 1)
    expect(applied).toEqual([])
    vi.advanceTimersByTime(1)
    expect(applied).toEqual(['row-3'])
  })
  it('a click wins over a waiting key move; leaving the tab cancels the wait', () => {
    vi.useFakeTimers()
    const applied: string[] = []
    const follow = dockFollower<string>((pick) => applied.push(pick))
    follow.soon('row-1')
    follow.now('row-9')
    vi.advanceTimersByTime(1000)
    expect(applied).toEqual(['row-9'])
    follow.soon('row-2')
    follow.cancel()
    vi.advanceTimersByTime(1000)
    expect(applied).toEqual(['row-9'])
  })
  it('"Draft kept on SO-…" names the newest record left with a draft, never the one shown', () => {
    const drafts = new Map([
      ['SalesOrder.a', 'SO-1'],
      ['Quote.b', 'QT-2'],
    ])
    expect(draftKeptOf(drafts, null)).toBe('QT-2')
    expect(draftKeptOf(drafts, 'Quote.b')).toBe('SO-1')
    expect(draftKeptOf(new Map([['SalesOrder.a', 'SO-1']]), 'SalesOrder.a')).toBeNull()
    expect(draftKeptOf(new Map(), null)).toBeNull()
  })
})

describe('F-SA-279: the page wires it (the sources)', () => {
  const hook = readFileSync(new URL('./use-customer-work.ts', import.meta.url), 'utf8')
  // F-CP-111 (end-check fix): the dock's own history writes only — the docked order's "All files" after them opens ANOTHER page
  // (the order's Files tab), a navigation Back returns from, not a write of `dock=`.
  const dockStart = hook.indexOf('export function useCustomerDock')
  const block = hook.slice(dockStart, hook.indexOf('// ---- F-CP-111', dockStart))
  it('a replace, never a push (Back leaves the page); the summary read checks an address\'s record', () => {
    // F-OP-211: the record pages' ONE history writer (a replace, only a different address); no router write of `dock=` any more.
    expect(block).toContain('writeSearch(dockAddress(pathname, window.location.search, next, messageId))')
    expect(block).not.toContain('router.replace')
    expect(block).not.toContain('router.push')
    expect(block).not.toContain('push: true')
    expect(block).toContain('readRecordSummary(api, { type: term.type, id: term.id }, controller.signal)')
    expect(block).toContain('if (!checked) return write(GENERAL_DOCK)')
    expect(hook).toContain('onAll: () => router.push(orderFilesHref(prefix, order.id))') // F-CP-111: a page of its own
  })
  it('the Work tab marks the docked order, reports the keys\' row and gives a phone card its door; Quotes & incoming too', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("active: can.threads ? { id: picked && picked.type === 'SalesOrder' ? picked.id : null, cardDoor: t('customers.work.dock.cardDoor') } : null")
    expect(tab).toContain('onFocusRow: (row: OrderRow) => onFocus?.(pickOfRow(row))')
    expect(tab).toContain('frame?.showThread?.()')
    const quotes = readFileSync(new URL('./QuotesIncomingTab.tsx', import.meta.url), 'utf8')
    expect(quotes).toContain("active: { id: shown?.type === 'Quote' ? shown.id : null }")
    expect(quotes).toContain("row.kind === 'CHANGE_REQUEST' ? undefined")
  })
  it('the dock: <customer> (general) · the record · All of <customer> (the feed\'s lines open their ONE conversation)', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    const dock = tab.slice(tab.indexOf('function Dock('))
    expect(dock).toContain("{ value: 'general', label: t('customers.work.dock.general'")
    expect(dock).toContain("{ value: 'all' as const, label: t('customers.work.dock.all'") // F-OP-213: offered when readable
    expect(dock).toContain('<AllOfCustomerDock label={`${t(\'customers.work.dock.all\', { customer: customer.name })} · ${t(\'customers.work.dock.readOnly\')}`} model={feed.model} actions={{ ...feed.actions, onAnswer, writeFirst, canAnswer, ...(frame?.compose ? { onCompose: frame.compose } : {}) }} foot={allFoot} />') // F-OP-204, 205, 207: the card with its Head and foot
    expect(dock).toContain('onDraft={(kept) => dock.onDraft(pick, kept)}')
    expect(dock).toContain("note={dock.draftKept ? t('customers.work.dock.draftKept', { record: dock.draftKept }) : null}")
    // No threads.read: no dock at all.
    expect(dock).toContain('if (general === null || general === undefined) return null')
  })
  it('Work\'s dock a third; the band\'s button below 1280 px names the record docked', () => {
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("defaultWidth={tab === 'work' ? 'third' : undefined}")
    expect(view).toContain('dockTab={tab}')
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("const threadButton = customerDock.shown ? t('customers.work.dock.button', { record: customerDock.shown.label }) : null")
    const frame = readFileSync(new URL('../../../_shared/record-frame/RecordFrame.tsx', import.meta.url), 'utf8')
    expect(frame).toContain("mode === 'stacked' && namedButton ? namedButton")
  })
  it('the words in both languages, the catalogue\'s own (R9): "conversazione", the All of title the feed\'s', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const rt = createTranslator(locale, messagesFor(locale, ['record-thread'])['record-thread']!)
      for (const key of ['all', 'readOnly', 'draftKept', 'button', 'cardDoor', 'generalLine']) expect(t(`customers.work.dock.${key}`, { customer: 'Brand Alpha', record: 'SO-1' }), `${locale} ${key}`).not.toBe(`customers.work.dock.${key}`)
      expect(t('customers.work.dock.all', { customer: 'Brand Alpha' })).toBe(rt('allOfCustomer.title', { customer: 'Brand Alpha' }))
    }
    const it = createTranslator('it', messagesFor('it', ['parties']).parties!)
    expect(it('customers.work.dock.button', { record: 'SO-1' })).toBe('Conversazione · SO-1')
    expect(it('customers.work.dock.generalLine', { customer: 'Brand Alpha' })).toContain("le note d'ufficio restano qui")
  })
})
// ---- end F-SA-279

// ---- fx-12 (the customer page that reloaded itself, 2026-11-19): every address the page writes is stable — written once, the next
// look at the address writes nothing (the Work tab's entry, then the sheet's lock, then the dock): no writer can feed another.
describe('fx-12: the customer page writes its address once', () => {
  const ORDER = '33333333-3333-4333-8333-333333333333'
  const search = (address: string) => address.slice(address.indexOf('?') + 1)
  it.each(['', 'tab=work', 'tab=orders', 'late=true', `tab=work&party=${BETA}&rows=all`, 'dock=all', `tab=work&status=IN_PRODUCTION&dock=SalesOrder.${ORDER}`, 'q=giacca&waiting=us'])(
    'the Work tab\'s entry from %j: applied twice gives the same address, and the sheet\'s lock then writes nothing',
    (query) => {
      const once = workEntry(BASE, ALPHA, params(query))
      const address = once ?? `${BASE}?${query}`
      expect(workEntry(BASE, ALPHA, params(search(address))), address).toBeNull()
      expect(lockedEntry(BASE, { locked: { party: ALPHA } }, params(search(address))), address).toBeNull()
    },
  )
  it('the dock writes only a different address: the same term again is the address as it is', () => {
    const entry = workEntry(BASE, ALPHA, params(''))!
    const term = { kind: 'record', type: 'SalesOrder', id: ORDER } as const
    const docked = dockAddress(BASE, `?${search(entry)}`, term)
    expect(dockAddress(BASE, `?${search(docked)}`, term)).toBe(docked)
    expect(dockAddress(BASE, `?${search(entry)}`, GENERAL_DOCK)).toBe(entry)
    // The docked address needs no entry write either (the dock term is not a view term).
    expect(workEntry(BASE, ALPHA, params(search(docked)))).toBeNull()
  })
})
// ---- end fx-12

// ---- F-OP-211 (order page plan N4; 11-dock §4): the customer page's `dock=` on the record pages' ONE history writer (the order page's
// `thread=` writer): a history replace, only when the address differs (fx-12's rule above, unchanged), never a push, the hash kept.
describe('F-OP-211: the dock writes `dock=` through the one history writer', () => {
  const ORDER = '44444444-4444-4444-8444-444444444444'
  function fakeWindow(address: string) {
    let now = new URL(address, 'https://factory.example.com')
    const writes: string[] = []
    const target: HistoryTarget = {
      location: {
        get pathname() {
          return now.pathname
        },
        get search() {
          return now.search
        },
        get hash() {
          return now.hash
        },
      },
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string | null) => {
          writes.push(String(url))
          now = new URL(String(url), now)
        },
        pushState: () => {
          throw new Error('the dock never pushes: Back leaves the page')
        },
      },
    }
    return { target, writes, search: () => now.search }
  }
  it('a pick is one replace; the same pick again writes nothing; the general one drops the term; the hash stays', () => {
    const { target, writes, search } = fakeWindow(`${BASE}?tab=work#orders`)
    const write = (term: Parameters<typeof dockAddress>[2]) => writeSearch(dockAddress(BASE, search(), term), {}, target)
    expect(write({ kind: 'record', type: 'SalesOrder', id: ORDER })).toBe(true)
    expect(write({ kind: 'record', type: 'SalesOrder', id: ORDER })).toBe(false)
    expect(write(GENERAL_DOCK)).toBe(true)
    expect(write(GENERAL_DOCK)).toBe(false)
    expect(writes).toEqual([`${BASE}?tab=work&dock=SalesOrder.${ORDER}#orders`, `${BASE}?tab=work#orders`])
  })
})
// ---- end F-OP-211

// ---- F-CP-101 (customer page plan C1, D7, K1; fx-12; review G4, E6): the Work tab opens on All orders ------------------------------
// The entry address has ONE writer (workEntry in WorkTab); applied to its own output it writes nothing. `rows=all`, never `status=all`
// (that term reads as Open orders and, being a view term, would stop every later write). Each new term — `list` (Drafts), `priceMatch`
// (Not equal), `cols` (Work · Money) — applied twice gives the same address. Sales › Orders keeps Open orders.
describe('F-CP-101: All orders by default, written once', () => {
  const search = (address: string) => address.slice(address.indexOf('?') + 1)
  const twice = (query: string) => {
    const once = workEntry(BASE, ALPHA, params(query))
    const address = once ?? `${BASE}?${query}`
    return { once, address, again: workEntry(BASE, ALPHA, params(search(address))) }
  }

  it("workEntry('') → tab=work&party=A&rows=all; applied to its own output → null", () => {
    expect(workEntry(BASE, ALPHA, params(''))).toBe(`${BASE}?tab=work&party=${ALPHA}&rows=all`)
    expect(twice('').again).toBeNull()
    expect(WORK_DEFAULT_ROWS).toBe('all')
    expect(new URL(`https://x${workEntry(BASE, ALPHA, params(''))!}`).searchParams.has('status')).toBe(false)
  })

  it.each([['status=IN_PRODUCTION', 'status'], ['late=true', 'late'], ['list=drafts', 'list'], ['priceMatch=NOT_EQUAL', 'priceMatch'], ['waiting=us', 'waiting']])('a view term (%s): no default written beside it', (query, term) => {
    const { once, again } = twice(`tab=work&party=${ALPHA}&${query}`)
    expect(once).toBeNull()
    expect(again).toBeNull()
    const entry = new URL(`https://x${workEntry(BASE, ALPHA, params(query))!}`).searchParams
    expect(entry.has('rows'), query).toBe(false)
    expect(entry.has(term), query).toBe(true)
  })

  it.each(['list=drafts', 'priceMatch=NOT_EQUAL', 'cols=money', 'tab=work&cols=money', `tab=work&party=${ALPHA}&cols=money&rows=all`])('each new term applied twice = the same address (%s)', (query) => {
    const { address, again } = twice(query)
    expect(again, address).toBeNull()
    expect(lockedEntry(BASE, { locked: { party: ALPHA } }, params(search(address))), address).toBeNull()
  })

  it('`cols` names no view: All orders is written beside it, once', () => {
    const written = new URL(`https://x${workEntry(BASE, ALPHA, params('tab=work&cols=money'))!}`).searchParams
    expect(written.get('rows')).toBe('all')
    expect(written.get('cols')).toBe('money')
  })

  it('the pairs: list=drafts with a view term keeps both, writes no default, once', () => {
    for (const query of ['list=drafts&status=IN_PRODUCTION', 'list=drafts&waiting=us', 'priceMatch=NOT_EQUAL&rows=all']) {
      const { address, again } = twice(query)
      expect(again, address).toBeNull()
      const kept = new URL(`https://x${address}`).searchParams
      expect(kept.get('tab')).toBe('work')
      expect(kept.get('party')).toBe(ALPHA)
      expect(kept.getAll('rows').length, query).toBeLessThanOrEqual(1)
    }
  })

  it('?tab=orders → rows=all once; a saved view without tab → tab and party back, once', () => {
    const old = twice('tab=orders')
    expect(new URL(`https://x${old.once!}`).searchParams.get('rows')).toBe('all')
    expect(old.again).toBeNull()
    const saved = twice('late=true')
    const back = new URL(`https://x${saved.once!}`).searchParams
    expect([back.get('tab'), back.get('party'), back.get('late'), back.has('rows')]).toEqual(['work', ALPHA, 'true', false])
    expect(saved.again).toBeNull()
  })

  it('the views in their order; Not equal only with the price grain (and once its step offers it); Drafts once its step offers it', () => {
    expect(WORK_VIEWS).toEqual(['all', IN_PRODUCTION_VIEW, WAITING_US_VIEW, 'late', DRAFTS_VIEW, NOT_EQUAL_VIEW])
    expect(IN_PRODUCTION_VIEW).toBe('phase:IN_PRODUCTION') // F-CW-101 (S3)
    expect(workViewsOf({ price: true }, { drafts: true, priceCheck: true })).toEqual([...WORK_VIEWS])
    expect(workViewsOf({ price: false }, { drafts: true, priceCheck: true })).toEqual(['all', IN_PRODUCTION_VIEW, WAITING_US_VIEW, 'late', DRAFTS_VIEW])
    expect(workViewsOf({ price: true })).toEqual(['all', IN_PRODUCTION_VIEW, WAITING_US_VIEW, 'late'])
  })

  it('the empty state per view: All orders says no order yet; In production keeps its way to All orders; a door, Waiting on us and Late their own sentence', () => {
    const t = createTranslator('en', messagesFor('en', ['parties']).parties!)
    const all = { href: '/all', label: 'Show all orders' }
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all')).toEqual({ title: 'Brand Alpha has no order yet.', view: 'all', newOrder: true /* F-CP-104 */ })
    expect(workEmptyOf('IN_PRODUCTION', null, 'Brand Alpha', t, '/all')).toEqual({ title: 'Nothing in production for Brand Alpha.', link: all, view: 'IN_PRODUCTION' })
    // F-CW-102 (S20; 10-design §3.7): a whole sentence per door and view, with Show all orders — shown whatever the door narrows.
    expect(workEmptyOf('late', null, 'Brand Alpha', t, '/all')).toEqual({ title: 'No order of Brand Alpha is late now.', link: all, always: true })
    expect(workEmptyOf('open', 'us', 'Brand Alpha', t, '/all')).toEqual({ title: 'No order of Brand Alpha waits on us now.', link: all, always: true })
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all', { phase: 'NOT_SENT' })).toEqual({ title: 'No order of Brand Alpha waits to be sent to the factory now.', link: all, always: true })
    expect((['NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE', 'CANCELLED'] as const).map((phase) => workEmptyOf('all', null, 'X', t, '/all', { phase })?.title)).toEqual([
      'No order of X waits to be sent to the factory now.',
      'No order of X waits for production to start now.',
      'No order of X is in production now.',
      'No order of X is ready to ship now.',
      'No order of X is shipped now.',
      'No order of X is done yet.',
      'No order of X is cancelled.',
    ])
    // Something else narrows the sheet (a search, another term): the sheet's own "No orders match" is the right answer.
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all', { phase: 'NOT_SENT', plain: false })).toBeNull()
    expect(workEmptyOf('late', null, 'Brand Alpha', t, '/all', { plain: false })).toBeNull()
    expect(workEmptyOf('open', 'us', 'Brand Alpha', t, '/all', { plain: false })).toBeNull()
    // No order at all, drafts in the portal: one more line and the way to them (never counted as orders).
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all', { drafts: { count: 2, href: '/drafts' } })).toEqual({ title: 'Brand Alpha has no order yet.', view: 'all', newOrder: true, body: '2 drafts are being written in the portal — never counted as orders.', link: { href: '/drafts', label: 'Show the drafts' } })
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all', { drafts: { count: 0, href: '/drafts' } })).toEqual({ title: 'Brand Alpha has no order yet.', view: 'all', newOrder: true })
    const it_ = createTranslator('it', messagesFor('it', ['parties']).parties!)
    expect(it_('customers.work.emptyAll', { customer: 'Brand Alpha' })).toBe('Brand Alpha non ha ancora ordini.')
    expect(workEmptyOf('all', null, 'Brand Alpha', it_, '/all', { phase: 'DONE' })?.title).toBe('Nessun ordine di Brand Alpha è ancora concluso.')
    expect(workEmptyOf('open', 'us', 'Brand Alpha', it_, '/all')?.title).toBe('Nessun ordine di Brand Alpha tocca a noi ora.')
  })

  // F-CW-102 (P0 item 9): a customer with no order read "No orders match … Clear filters", as if a filter were set — the host's
  // locked customer counted as a narrowing. It is the page's own: its empty sheet says the host's words.
  it('F-CW-102: the page\'s own customer is no narrowing — an empty sheet says "<customer> has no order yet."', async () => {
    const { hostEmptyOf } = await import('../../orders/list/view/OrdersListView')
    const view = readFileSync(new URL('../../orders/list/view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('(!!model.customer && !model.locked?.party)')
    const empty = { title: 'Brand Alpha has no order yet.', view: 'all' as const, newOrder: true }
    expect(hostEmptyOf({ empty, rows: 'all' }, false, false)).toBe(empty)
    expect(hostEmptyOf({ empty, rows: 'all' }, true, true)).toBeNull() // a search or another term: "No orders match"
    // A door's sentence shows whatever the door narrows (the host gives it only when nothing else does).
    const door = { title: 'No order of Brand Alpha is done yet.', always: true }
    expect(hostEmptyOf({ empty: door, rows: 'all' }, true, true)).toBe(door)
    // New order beside the words is not drawn without orders.manage (S9), and the host's link sits beside it.
    expect(view).toContain('(hostEmpty.newOrder && model.can.manage) || hostEmpty.link ? (')
  })

  it('Sales › Orders keeps Open orders as its default (the customer page only changes)', () => {
    expect(rowsFromAddress(params(''))).toBe('open')
    expect(rowsFromAddress(params('rows=all'))).toBe('all')
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('clearTo: WORK_DEFAULT_ROWS') // F-CP-102: the sheet's default view = the host's
    expect(tab.match(/router\.replace\(/g)?.length, 'one writer of the entry address').toBe(1)
  })
})
// ---- end F-CP-101

// ---- F-CP-103 (customer page plan C1; review A4): the Overview's tiles open their own view; Views ▾ counts each view ----------------
describe('F-CP-103: each tile opens the rows it counts; the Views counts come from the one count read', () => {
  const RECORD = `/w/acme/sales/customers/${ALPHA}`
  const viewOf = (href: string) => rowsFromAddress(new URL(`https://x${href}`).searchParams)

  // F-CW-101 (lead settle S3): "In production" means ONE thing on the customer page — the STARTED orders (the phase IN_PRODUCTION):
  // the Overview's tile, the Views ▾ item and the band's group count the same orders and open the same door.
  it('Open orders → rows=open, In production → phase=IN_PRODUCTION, Late → late=true (the views the tiles count)', () => {
    expect(workDoor(RECORD, 'open')).toBe(`${RECORD}?tab=work&rows=open`)
    expect(workDoor(RECORD, 'inProduction')).toBe(`${RECORD}?tab=work&phase=IN_PRODUCTION`)
    expect(workDoor(RECORD, 'late')).toBe(`${RECORD}?tab=work&late=true`)
    expect([viewOf(workDoor(RECORD, 'open')), viewOf(workDoor(RECORD, 'late'))]).toEqual(['open', 'late'])
    // The rows each door reads are the rows its tile counts: Open = the open states, Late = open and promised before today,
    // In production = every order (`rows=all`, written by the entry) in the phase IN_PRODUCTION (the API's own rule).
    expect([...OPEN_ORDERS].sort()).toEqual([...OPEN_STATUSES].sort())
    expect(rowsQuery('open', '', null, ALPHA)).toMatchObject({ open: true, partyId: ALPHA })
    expect(rowsQuery('late', '', null, ALPHA)).toMatchObject({ late: true, partyId: ALPHA })
    const entered = new URL(`https://x${workEntry(RECORD, ALPHA, params(workDoor(RECORD, 'inProduction').split('?')[1]!))!}`).searchParams
    expect(viewOf(`${RECORD}?${entered.toString()}`)).toBe('all')
    expect(rowsQuery('all', '', null, ALPHA, { extra: extraFromAddress(entered, 'all') })).toMatchObject({ phase: 'IN_PRODUCTION', partyId: ALPHA })
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    for (const door of ['open', 'inProduction', 'late']) expect(view).toContain(`href: workDoor(recordHref, '${door}')`)
    // A1-B5: In production and Late are the board's counts (the API's rule), no longer counted in the browser from the record's orders.
    expect(view).toContain("const started = board ? phaseCountOf(board, 'IN_PRODUCTION') : null")
    expect(view).toContain("const late = board ? (board.tiles.find((tile) => tile.key === 'late')?.count ?? 0) : null")
    expect(view).not.toContain("order.status === 'IN_PRODUCTION'")
    expect(view).not.toContain('order.promiseDate < today')
    // S29: Open quotes opens Quotes & incoming at its open quotes.
    expect(view).toContain("href: openQuotesHref ?? tabHref('quotes')")
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("openQuotesHref={quotesGroupDoor(`${prefix}/sales/customers/${encodeURIComponent(partyId)}`, 'OPEN_QUOTES')")
    expect(page).toContain('workBoard={work.reads.board')
  })

  it('a door arrives with its view: the entry adds the lock once and no default beside the view (fx-12)', () => {
    for (const door of ['open', 'inProduction', 'late'] as const) {
      const query = workDoor(BASE, door).split('?')[1]!
      const once = workEntry(BASE, ALPHA, params(query))!
      const written = new URL(`https://x${once}`).searchParams
      expect(written.get('party'), door).toBe(ALPHA)
      // One view each: rows=open; phase=IN_PRODUCTION with its rows=all (S16: a phase is over every order); late=true.
      expect(written.getAll('rows').length + written.getAll('status').length + written.getAll('late').length, door).toBe(1)
      expect(written.get('phase'), door).toBe(door === 'inProduction' ? 'IN_PRODUCTION' : null)
      expect(workEntry(BASE, ALPHA, params(once.split('?')[1]!)), door).toBeNull()
    }
  })

  it('the counts: All orders (every state), In production, Late from the strip\'s board read; nothing while it reads; Waiting on us no number', () => {
    expect(workViewCounts({ status: 'reading' })).toBeNull()
    expect(workViewCounts({ status: 'failed' })).toBeNull()
    // F-CW-101 (S3): In production counts the STARTED orders (the board's byPhase: 4 of the 7 in that state), the number its door opens.
    const byPhase = [{ phase: 'NOT_SENT', count: 3 }, { phase: 'NOT_STARTED', count: 3 }, { phase: 'IN_PRODUCTION', count: 4 }, { phase: 'READY', count: 0 }, { phase: 'SHIPPED', count: 0 }, { phase: 'DONE', count: 32 }, { phase: 'CANCELLED', count: 0 }]
    const ready = { status: 'ready' as const, value: { byStatus: [{ status: 'CONFIRMED', count: 3 }, { status: 'IN_PRODUCTION', count: 7 }, { status: 'CLOSED', count: 32 }], byPhase, lanes: [], tiles: [{ key: 'late', count: 2, filter: {} }], asOf: '2026-11-19T10:00:00Z' } } as never
    const counts = workViewCounts(ready)!
    expect(counts).toEqual({ all: 42, [IN_PRODUCTION_VIEW]: 4, late: 2 })
    // An older answer without byPhase: no number beside In production (never a guess from the state, which holds the not-started too).
    const older = { status: 'ready' as const, value: { byStatus: [{ status: 'IN_PRODUCTION', count: 7 }], lanes: [], tiles: [], asOf: '2026-11-19T10:00:00Z' } } as never
    expect(workViewCounts(older)).toEqual({ all: 7, late: 0 })
    const orders = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const sheet = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const items = builtInViewsOf({ customer: { id: ALPHA, name: 'Brand Alpha' }, locked: { party: true, kind: false }, views: workViewsOf({ price: true }), hostViews: [{ id: IN_PRODUCTION_VIEW, label: orders('rows.IN_PRODUCTION') }], viewCounts: counts }, orders, sheet)
    expect(items.map((item) => [item.label, item.count ?? null])).toEqual([['All orders', '42'], ['In production', '4'], ['Waiting on us', null], ['Late', '2']])
    // The page names the customer: no "Orders of Brand Alpha" line under each item on its own page.
    expect(items.some((item) => item.hint)).toBe(false)
  })

  it('no second read: the Work tab hands the sheet the strip\'s read (brand wall: the API walls it to this customer)', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('viewCounts: { ...(workViewCounts(work.reads.board) ?? {})') // F-CP-107 / F-CP-141: the drafts' and Not equal's counts beside it
    expect(tab).not.toMatch(/getBoard\(/)
    const hook = readFileSync(new URL('./use-customer-work.ts', import.meta.url), 'utf8')
    expect(hook).toContain("board: () => run('board', () => getBoard(api, '', undefined, partyId))")
  })
})
// ---- end F-CP-103

// ---- F-CP-104 (customer page plan C2a; fx-12, review G4, A9): New order and Import orders in place ---------------------------------
// The band's New order and ⋯ Import orders for <customer>… are asks kept in the page's memory, never address terms: on the Work tab
// nothing is written (the window opens in place); on another tab the page writes `tab=work`, the Work entry writes its lock and view
// once, then nothing — two replaces at most, then none. The window holds the page's customer (no Change); held without orders.manage.
describe('F-CP-104: New order and Import orders open on the customer page', () => {
  const RECORD = `/w/acme/sales/customers/${ALPHA}`
  const search = (address: string) => address.slice(address.indexOf('?') + 1)

  it('on the Work tab the ask writes nothing; on another tab ?tab=work, then the entry once, then none (two replaces at most)', () => {
    expect(workAskAddress(RECORD, 'work')).toBeNull()
    for (const tab of ['overview', 'quotes', 'money', 'people', 'terms', 'portal']) {
      const first = workAskAddress(RECORD, tab)!
      expect(first, tab).toBe(`${RECORD}?tab=work`)
      const second = workEntry(RECORD, ALPHA, params(search(first)))!
      expect(new URL(`https://x${second}`).searchParams.get('rows'), tab).toBe('all')
      expect(workEntry(RECORD, ALPHA, params(search(second))), tab).toBeNull()
      // No term of the ask anywhere: nothing to loop on, a reload does not reopen the window.
      for (const address of [first, second]) expect(address, tab).not.toMatch(/[?&](new|import)=/)
    }
  })

  it('the page keeps the ask in memory and the Work sheet serves it once (no address write of its own)', () => {
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain("const address = workAskAddress(`${prefix}/sales/customers/${encodeURIComponent(partyId)}`, tab)")
    expect(page).toContain('onAsked={() => setAsk(null) /* F-CP-104 */}')
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("if (ask === 'new') latest.current.onNewOrder?.(true)")
    expect(tab).toContain('else latest.current.onImport?.()')
    expect(tab.match(/router\.replace\(/g)?.length).toBe(1)
  })

  it('the band: New order is a button on this page; ⋯ Import orders opens here; both held with the right\'s words without orders.manage', () => {
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<Button size="sm" variant="primary" onClick={onNewOrder}>')
    expect(view).toContain("onSelect: onImport, disabled: !can.ordersManage")
    expect(view).toContain("heldReason={t('held.right', { right: rightRef('orders.manage') })}")
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['parties']).parties!)('held.right', { right: rightRef('orders.manage') })
      expect(words, locale).not.toContain('orders.manage')
      expect(words, locale).not.toBe('held.right')
    }
    expect(createTranslator('en', messagesFor('en', ['parties']).parties!)('held.right', { right: rightRef('orders.manage') })).toMatch(/^Needs the right /)
  })
})
// ---- end F-CP-104

// ---- F-CP-113 (customer page plan C2a; review A2): "Add the lines" opens the lines editor in a large window on this page ------------
describe('F-CP-113: the lines editor in a large window on the customer page', () => {
  const tab = () => readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')

  it('"Add the lines" hands the header to the page\'s window (the New order window closes); Sales › Orders keeps the editor\'s page', () => {
    expect(tab()).toContain('onAddLines: setLines, // F-CP-113')
    const sheet = readFileSync(new URL('../../orders/list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('if (host.onAddLines) {')
    expect(sheet).toContain('return host.onAddLines(header)')
    expect(sheet).toContain('router.push(newOrderAddress(prefix, header))')
  })

  it('no address term and no page hop: the window lives in the page\'s memory; Confirm closes it on the new order and says so', () => {
    const source = tab()
    expect(source.match(/router\.replace\(/g)?.length).toBe(1)
    expect(source).toContain("toast(o('newOrder.window.made', { number: order.number }), 'success')")
    expect(source).toContain('if (can.threads) onPick(pickOfRow({ id: order.id, number: order.number, companyId: lines.companyId }))')
    expect(source).toContain('onDiscarded={() => setLines(null)}')
    expect(source).toContain('onClose={() => setLines(null)}')
  })

  it('the design cases: the window with lines, without prices, and the Discard question', () => {
    const fixtures = readFileSync(new URL('./fixtures.ts', import.meta.url), 'utf8')
    for (const id of ['work-new-order-lines', 'work-new-order-lines-no-price', 'work-new-order-discard']) expect(fixtures).toContain(`id: '${id}'`)
  })
})
// ---- end F-CP-113

// ---- F-CP-141 (customer page plan C2d, C4; 11-money §3.2; 10 §5; review E5, E6): the "Not equal" view ------------------------------
// `rows=all&priceMatch=NOT_EQUAL`, offered only with the price grain; its preset MONEY_PRESET; its count from the customer's own
// counts (GET /sales/brand-prices/summary: the API walls it to this customer); the Money tab's "Prices differ on {count} orders ›".
// Money wall "as Sales worker / as Production manager": no view, no count, no Money line; a shared saved view with the term opened by
// a non-holder = ONE line (orders.held.noPrice) + Show all orders, and no read carries the term.
describe('F-CP-141: the Not equal view', () => {
  const OWNER = canOf('owner')
  const SALES_WORKER = { ...canOf('sales'), price: false } // the Sales role after B-CP-011
  const MANAGER = canOf('manager') // the production manager: orders.view, no money grain
  const search = (address: string) => address.slice(address.indexOf('?') + 1)
  const html = (id: string, locale: (typeof LOCALES)[number] = 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)!
    const View = designScreen.view as (props: { model: unknown }) => ReturnType<typeof createElement>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model: item.model })))
  }

  it('the address applied twice = the same (fx-12): the view\'s door and the term; the entry writes the lock only, once', () => {
    const door = notEqualDoor(BASE)
    expect(door).toBe(`${BASE}?tab=work&${NOT_EQUAL_TERMS}`)
    const once = workEntry(BASE, ALPHA, params(search(door)))!
    const written = new URL(`https://x${once}`).searchParams
    expect([written.get('tab'), written.get('party'), written.get('rows'), written.get('priceMatch')]).toEqual(['work', ALPHA, 'all', 'NOT_EQUAL'])
    expect(workEntry(BASE, ALPHA, params(search(once)))).toBeNull()
    // The sheet writes the same terms back (the lock and the page's tab kept), and reading them again writes nothing new.
    const host = { locked: { party: ALPHA }, keep: ['tab', 'dock'] }
    const extra = extraFromAddress(params(search(once)), 'all')
    expect(extra).toEqual({ priceMatch: 'NOT_EQUAL' })
    const again = sheetAddress(BASE, host, params(search(once)), { rows: 'all', q: '', layout: 'list', extra })
    expect(new URL(`https://x${again}`).searchParams.get('priceMatch')).toBe('NOT_EQUAL')
    expect(sheetAddress(BASE, host, params(search(again)), { rows: 'all', q: '', layout: 'list', extra: extraFromAddress(params(search(again)), 'all') })).toBe(again)
    expect(lockedEntry(BASE, { locked: { party: ALPHA } }, params(search(again)))).toBeNull()
  })

  it('the term: read from the address (a known value only), written back, sent to the list and its totals — never to the board', () => {
    expect(extraFromAddress(params('priceMatch=NOT_EQUAL'), 'all').priceMatch).toBe('NOT_EQUAL')
    expect(extraFromAddress(params('priceMatch=NO_BRAND_PRICE'), 'all').priceMatch).toBe('NO_BRAND_PRICE')
    expect(extraFromAddress(params('priceMatch=equal'), 'all').priceMatch).toBeUndefined()
    expect(extraFromAddress(params('priceMatch=MAYBE'), 'all').priceMatch).toBeUndefined()
    expect(listAddress(BASE, { rows: 'all', q: '', layout: 'list', extra: { priceMatch: 'NOT_EQUAL' } })).toBe(`${BASE}?rows=all&priceMatch=NOT_EQUAL`)
    expect(rowsQuery('all', '', null, ALPHA, { extra: { priceMatch: 'NOT_EQUAL' } }).priceMatch).toBe('NOT_EQUAL')
    expect(boardNarrowOf({ extra: { priceMatch: 'NOT_EQUAL' } })).not.toHaveProperty('priceMatch')
    const api = readFileSync(new URL('../../orders/api.ts', import.meta.url), 'utf8')
    expect(api.match(/priceMatch: query\.priceMatch \?\? undefined/g)?.length, 'the list and its totals').toBe(2)
  })

  it('a pick: the view and the term alone in one write; the funnel narrows the view shown; leaving drops the term only', () => {
    expect(withPriceMatch({ atRisk: true }, 'NOT_EQUAL', true)).toEqual({ priceMatch: 'NOT_EQUAL' })
    expect(withPriceMatch({ atRisk: true }, 'EQUAL')).toEqual({ atRisk: true, priceMatch: 'EQUAL' })
    expect(withPriceMatch({ atRisk: true, priceMatch: 'NOT_EQUAL' }, null)).toEqual({ atRisk: true })
    expect(notEqualShown('all', null, { priceMatch: 'NOT_EQUAL' })).toBe(true)
    expect(notEqualShown('late', null, { priceMatch: 'NOT_EQUAL' })).toBe(false)
    expect(notEqualShown('all', 'us', { priceMatch: 'NOT_EQUAL' })).toBe(false)
    expect(notEqualShown('all', null, { priceMatch: 'EQUAL' })).toBe(false)
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("else if (id === NOT_EQUAL_VIEW) sheet.actions.onPriceMatch?.('NOT_EQUAL', { rows: 'all' })")
    expect(tab).toContain('const onRows = leave ? (next: RowView) => leave(null, { rows: next }) : sheet.actions.onRows')
    expect(tab.match(/router\.replace\(/g)?.length, 'still one writer of the entry address').toBe(1)
    const sheet = readFileSync(new URL('../../orders/list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('go({ extra: withPriceMatch(extra, match, !!view && !!match)')
  })

  it('Not equal only with the price grain: the view, its item, its count; as Sales worker / as Production manager none of them', () => {
    expect(workViewsOf(OWNER, { drafts: true, priceCheck: true })).toContain(NOT_EQUAL_VIEW)
    for (const can of [SALES_WORKER, MANAGER]) expect(workViewsOf(can, { drafts: true, priceCheck: true })).not.toContain(NOT_EQUAL_VIEW)
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("...(price ? [{ id: NOT_EQUAL_VIEW, label: t('customers.work.view.notEqual'), active: notEqual }] : [])")
    expect(tab).toContain('const notEqualCount = price ? priceDifferOf(work.prices) : null')
    // The Owner's view carries the term's chip; as Sales worker the same address shows no chip and no price word.
    expect(html('work-not-equal')).toContain('Prices differ')
    const seen = html('work-not-equal-no-price')
    expect(seen).not.toContain('Prices differ')
    expect(seen).not.toContain('>Not equal<')
  })

  it('the count: the customer\'s own counts (one read, this customer only), read only with the price grain, again on an order\'s change', () => {
    expect(priceDifferOf({ status: 'ready', value: { partyId: ALPHA, priceNotEqualCount: 2, priceMissingCount: 5 } })).toBe(2)
    expect(priceDifferOf({ status: 'ready', value: { partyId: ALPHA, priceNotEqualCount: 0, priceMissingCount: 0 } })).toBe(0)
    for (const read of [{ status: 'reading' }, { status: 'failed' }, { status: 'off' }] as const) expect(priceDifferOf(read)).toBeNull()
    expect(pricesTouched('sales_order.brand_price_changed')).toBe(true)
    expect(pricesTouched('sales_order.confirmed')).toBe(true)
    expect(pricesTouched('thread.message_posted')).toBe(false)
    const hook = readFileSync(new URL('./use-customer-work.ts', import.meta.url), 'utf8')
    expect(hook).toContain("api.get('/sales/brand-prices/summary', { query: { partyId }, schema: priceSummarySchema, signal })")
    expect(hook).toContain('const pricesAllowed = can.orders && can.price === true')
    expect(hook).toContain("const [prices, setPrices] = useState<Read<PriceSummary>>(pricesAllowed ? READING : OFF)")
    const page = readFileSync(new URL('./CustomerRecord.tsx', import.meta.url), 'utf8')
    expect(page).toContain('price: can.price /* F-CP-141 */')
    expect(page).toContain('priceDiffer={priceDifferOf(work.prices) /* F-CP-141 */}')
  })

  it('its preset: Number · Status · Our price · Customer\'s price · Price check · Balance; wide Picture · Promised · Paid; Difference in Customise', () => {
    expect(MONEY_PRESET.shown).toEqual(['number', 'status', 'ourPrice', 'brandPrice', 'priceMatch', 'balance'])
    expect(MONEY_PRESET.wide).toEqual(['picture', 'promised', 'paid'])
    expect([...MONEY_PRESET.shown, ...(MONEY_PRESET.wide ?? [])]).not.toContain('priceDiff')
    expect(workPreset('all', null, true)).toBe(MONEY_PRESET)
    expect(workPreset('all', null, true, 'widest')).toBe(MONEY_PRESET) // its wide columns return in the widest room (the sheet's `wide`)
    // Review E5: All orders keeps today's columns (the money comes with the Not equal view or the toggle).
    for (const room of ['base', 'wide', 'wider', 'widest'] as const) {
      expect(workPreset('all', null, false, room).shown, room).not.toContain('ourPrice')
      expect(workPreset('all', null, false, room).shown, room).not.toContain('priceMatch')
    }
  })

  it('the Money tab: "Prices differ on {count} orders ›" for a price holder (the Not equal view\'s door); nothing for anyone else', () => {
    const owner = html('tab-money-price-differ')
    expect(owner).toContain('Prices differ on 2 orders ›')
    expect(owner).toContain(`tab=work&amp;rows=all&amp;priceMatch=NOT_EQUAL`)
    const sales = html('tab-money-price-differ-no-price')
    expect(sales).not.toContain('Prices differ')
    expect(sales).not.toContain('priceMatch')
    expect(html('tab-money-price-differ', 'it')).toContain('Prezzi diversi su 2 ordini ›')
    const tab = readFileSync(new URL('./view/MoneyTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('const differ = price && can.orders && priceDiffer !== null && priceDiffer > 0 ? priceDiffer : null')
  })

  it('a non-holder opens a shared view with the term: one line + Show all orders, no read carries it, no address write', () => {
    for (const can of [SALES_WORKER, MANAGER]) {
      const seen = priceTermOf({ priceMatch: 'NOT_EQUAL', atRisk: true }, can)
      expect(seen).toEqual({ extra: { atRisk: true }, held: true })
    }
    expect(priceTermOf({ priceMatch: 'NOT_EQUAL' }, OWNER)).toEqual({ extra: { priceMatch: 'NOT_EQUAL' }, held: false })
    expect(priceTermOf({ atRisk: true }, SALES_WORKER)).toEqual({ extra: { atRisk: true }, held: false })
    expect(abilitiesOf(['orders.view']).price).toBe(false)
    const sheet = readFileSync(new URL('../../orders/list/use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('const priceTerm = priceTermOf(extraFromAddress(params, rows), can)')
    expect(sheet).toContain('if (priceHeld) {')
    expect(sheet).toContain('const wantsSummary = !priceHeld /* F-CP-141 */')
    const seen = html('work-not-equal-no-price')
    expect(seen).toContain('Amounts are shown to people who see prices')
    expect(seen).toContain('Show all orders')
    expect(html('work-not-equal-no-price', 'it')).toContain('Gli importi sono visibili a chi vede i prezzi')
  })

  it('the chip of the term (a price holder\'s), and the words in both languages', () => {
    const orders = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const sheetWords = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    expect(extraChips({ priceMatch: 'NOT_EQUAL' }, orders, sheetWords)).toEqual([{ key: 'priceMatch', label: 'Prices differ' }])
    for (const locale of LOCALES) {
      const p = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      const o = createTranslator(locale, messagesFor(locale, ['orders']).orders!)
      for (const key of ['customers.work.view.notEqual']) expect(p(key), `${locale} ${key}`).not.toBe(key)
      expect(p('customers.work.priceDiffer', { count: 1 }), locale).not.toContain('customers.work')
      for (const key of ['priceCheck.chip.EQUAL', 'priceCheck.chip.NOT_EQUAL', 'priceCheck.chip.NO_BRAND_PRICE', 'priceCheck.showAll', 'held.noPrice']) expect(o(key), `${locale} ${key}`).not.toBe(key)
    }
    expect(createTranslator('it', messagesFor('it', ['parties']).parties!)('customers.work.view.notEqual')).toBe('Prezzi diversi')
  })
})
// ---- end F-CP-141

// ---- F-CP-111 (customer page plan C2c; 10-customer-page §4; review B1): the dock's files line on this page = the docked order's file set
describe('F-CP-111 — the docked order\'s files line is the order\'s file set (its Files tab\'s count); the general scope unchanged', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  const ORDER = { type: 'SalesOrder', id: '0190f0e2-5151-7000-8000-000000000142', label: 'SO-2026-0142', companyId: null }
  const QUOTE = { type: 'Quote', id: '0190f0e2-4141-7000-8000-000000000012', label: 'Q-2026-0112', companyId: null }
  it('only an ORDER docked in its own thread gets the order\'s set; the general scope, All of <customer> and other records keep their own line', async () => {
    const { orderShownOf } = await import('./use-customer-work')
    expect(orderShownOf('record', ORDER)).toBe(ORDER)
    expect(orderShownOf('general', ORDER)).toBeNull()
    expect(orderShownOf('all', ORDER)).toBeNull()
    expect(orderShownOf('record', QUOTE)).toBeNull()
    expect(orderShownOf('record', null)).toBeNull()
  })
  it('files count = the order\'s Files tab: one tile per listed file, "Files (N)" with N = read.total (the same container\'s read)', async () => {
    const { stripFilesOf } = await import('../../../_shared/record-thread/use-order-files')
    const { fileSeries, filesChip } = await import('../../../../lib/record-thread/files/model')
    const { ORDER_FILES } = await import('../../orders/record/overview/fixtures')
    const tiles = stripFilesOf(ORDER_FILES, ALPHA)
    expect(filesChip(fileSeries(tiles)).count).toBe(ORDER_FILES.total)
    const { render, textOf } = await import('../../../../lib/record-thread/parts/testing')
    const { FileStrip } = await import('../../../../lib/record-thread/files/view/FileStrip')
    expect(textOf(render(createElement(FileStrip, { model: { files: tiles, party: null, open: false } })))).toContain(`Files (${ORDER_FILES.total})`)
    // The order page's Files tab counts the same read (model.files.read.total).
    expect(read('../../orders/record/view/OrderRecordView.tsx')).toContain("count: tab === 'files' ? (model.files?.read?.total ?? null)")
  })
  it('the page mounts the order lane\'s ONE container for the docked order (no read of its own in the dock) and hands it as `orderFiles`', () => {
    const hook = read('./use-customer-work.ts')
    expect(hook).toContain("import { useOrderFiles, type OrderFilesHost } from '../../../_shared/record-thread/use-order-files'")
    expect(hook.match(/useOrderFiles\(api, \{/g)).toHaveLength(1)
    expect(hook).toContain('const order = orderShownOf(scope, pick)')
    expect(hook).toContain('enabled: !!order && readsFiles,')
    expect(hook).toContain("canShare: session.permissions.includes('files.manage'),")
    expect(hook).toContain('onAll: () => router.push(orderFilesHref(prefix, order.id)),')
    expect(hook).toContain("onOpen: (fileId, opener) => orderFiles.actions.onOrderOpen?.(fileId, 'preview', opener),")
    expect(hook).toContain("change.type === 'file.available' && filesAgain()")
    // The dock passes it to the docked ORDER's thread only (F-OP-215's host prop); the general thread keeps its own files line.
    const dock = read('./view/WorkTab.tsx')
    expect(dock).toContain("{...(dock.orderFiles && pick.type === 'SalesOrder' ? { orderFiles: dock.orderFiles } : {}) /* F-CP-111: the files line = the order's file set */}")
    const general = dock.slice(dock.indexOf('function Dock('))
    expect(general.match(/orderFiles: dock\.orderFiles/g)).toHaveLength(1)
    // A tile opens the ONE viewer here (the container's walk); the view fetches nothing.
    expect(dock).toContain('const viewer = scope === \'record\' ? (dock.orderFiles?.model.viewer ?? null) : null')
    expect(dock).toContain('<FileViewer')
  })
  it('"All files" opens the order page\'s Files tab', async () => {
    const { orderFilesHref } = await import('./use-customer-work')
    expect(orderFilesHref('/w/acme', '0190f0e2-5151-7000-8000-000000000142')).toBe('/w/acme/sales/orders/0190f0e2-5151-7000-8000-000000000142?tab=files')
  })
  it('the money wall and the brand wall stay the API\'s: the order\'s set is walled by its read (a priced document never named on the line)', async () => {
    const { stripFilesOf } = await import('../../../_shared/record-thread/use-order-files')
    const { ORDER_FILES } = await import('../../orders/record/overview/fixtures')
    // The line draws only what the read lists: a document the read leaves out (priced, without the price grain; another customer's) has
    // no tile, no name.
    const leftOut = { ...ORDER_FILES, groups: ORDER_FILES.groups.map((group) => ({ ...group, files: [], leftOut: group.files.length })), total: 0 }
    expect(stripFilesOf(leftOut, ALPHA)).toEqual([])
    const api = read('../../../../../../factory-api/src/modules/sales/orders/order-files.ts')
    expect(api).toContain('if (file.priced && !sees) {')
    expect(api).toContain('group.pricedLeftOut += 1')
  })
})
// ---- end F-CP-111

// ---- cp-walk (customer page review walk): the Work design cases draw what the live Work tab draws ----
// The walk found the SCR-033 Work cases short of the live page's parts: the band's New order held for the Owner ("Needs the right
// Work on sales orders": the design's record rights had no orders.manage), and no row ⋯ Next steps, no Set customer's price…, none of
// the bar's Reply to N · Mark N ready… · Close N… · Confirm N… (the design gave the sheet none of the doors use-orders-sheet gives).
describe('cp-walk: the Work design cases draw the live page\'s band and the sheet\'s doors', () => {
  const html = (id: string) => {
    const item = designScreen.cases.find((entry) => entry.id === id)!
    const View = designScreen.view as (props: { model: unknown }) => ReturnType<typeof createElement>
    return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(View, { model: item.model })))
  }
  const NEEDS_ORDERS = 'Needs the right Work on sales orders'
  it('the band\'s New order opens for a person who takes orders (the Owner, Sales); held in words only without orders.manage', () => {
    for (const id of ['quotes-orders', 'work-new-order', 'work-new-order-no-price', 'work-bulk-bar']) expect(html(id), id).not.toContain(NEEDS_ORDERS)
    for (const id of ['cp-148-work-manager', 'work-bulk-bar-manager']) expect(html(id), id).toContain(NEEDS_ORDERS)
  })
  it('three orders ticked: Reply to N, Mark 3 ready…, Close 3…, Confirm 3…; the production manager: only Mark 3 ready…, held in words', () => {
    const owner = html('work-bulk-bar')
    for (const words of ['Reply to Moda Demo on 3…', 'Mark 3 ready…', 'Close 3…', 'Confirm 3…']) expect(owner, words).toContain(words)
    const manager = html('work-bulk-bar-manager')
    expect(manager).toContain('Mark 3 ready…')
    for (const words of ['Reply to Moda Demo on 3…', 'Close 3…', 'Confirm 3…']) expect(manager, words).not.toContain(words)
  })
  it('the doors the live sheet has: Next steps and the bulk commands for everyone; Set customer\'s price… only with the price grain', async () => {
    const { workDoors } = await import('./fixtures')
    const owner = workDoors({}, true)
    expect([!!owner.onCommand, !!owner.onCommandMany, !!owner.onReplyMany, !!owner.onPriceCheck]).toEqual([true, true, true, true])
    expect(workDoors({}, false).onPriceCheck, 'money wall: no door without the price grain').toBeUndefined()
    const manager = workDoors({ role: 'manager' }, false)
    expect([!!manager.onCommand, !!manager.onCommandMany, !!manager.onReplyMany, !!manager.onPriceCheck]).toEqual([true, true, false, false])
  })
})
// ---- end cp-walk
