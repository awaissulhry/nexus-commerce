import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { viewQuery } from '@nexus/factory-domain/views/state'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { rowsQuery, listAddress } from '../../orders/model'
import { sheetAddress } from '../../orders/list/use-orders-sheet'
import { builtInActive, builtInViewsOf, pickBuiltIn, WAITING_US_VIEW, withPreset } from '../../orders/list/view/OrdersListView'
import { marksOf, sourcesTouched, STRIP_GROUPS, tileOf, tilesShown, workAttention, workEntry, WORK_DEFAULT_ROWS, type WorkReads } from './use-customer-work'
import { valueOf } from './view/WaitingStrip'
import { pickOfRow, WORK_VIEWS, workPreset } from './view/WorkTab'
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
  it('All orders · In production · Waiting on us · Late, in that order; Sales › Orders keeps its own list (no Waiting on us unasked)', () => {
    expect(builtInViewsOf({ customer: null, views: workViewsOf({ price: true }) }, orders, sheet).map((view) => view.label)).toEqual(['All orders', 'In production', 'Waiting on us', 'Late'])
    expect(builtInViewsOf({ customer: null }, orders, sheet).some((view) => view.id === WAITING_US_VIEW)).toBe(false)
  })
  it('the active view and a pick: each view stands alone', () => {
    expect(builtInActive({ rows: 'open', kind: null, waiting: 'us' })).toBe(WAITING_US_VIEW)
    expect(builtInActive({ rows: 'IN_PRODUCTION', kind: null, waiting: null })).toBe('IN_PRODUCTION')
    const calls: unknown[][] = []
    const actions = { onRows: (...args: unknown[]) => calls.push(['rows', ...args]), onWaiting: (...args: unknown[]) => calls.push(['waiting', ...args]), onKind: (...args: unknown[]) => calls.push(['kind', ...args]) }
    pickBuiltIn(WAITING_US_VIEW, { waiting: null }, actions)
    pickBuiltIn('late', { waiting: 'us' }, actions)
    pickBuiltIn('all', { waiting: null }, actions)
    expect(calls).toEqual([['waiting', 'us', 'open'], ['waiting', null, 'late'], ['rows', 'all']])
  })
  it('the columns of each view (In production: no Status; All orders: Status, Waiting on from 1800 px); ⋯ always; Customer never', () => {
    const live = workPreset('IN_PRODUCTION', null)
    expect(live.shown).not.toContain('status')
    expect(live.shown).toEqual(expect.arrayContaining(['picture', 'number', 'whereItIs', 'promised', 'waitingOn', 'newMessages']))
    expect(workPreset('all', null).shown).toContain('status')
    expect(workPreset('all', null).wide).toContain('waitingOn')
    expect(workPreset('open', 'us').shown).toContain('waitingOn')
    for (const preset of [live, workPreset('all', null), workPreset('late', null)]) expect([...preset.shown, ...(preset.wide ?? [])]).not.toContain('customer')
    expect(withPreset({ colId: 'more' }, live, false).hide).toBeUndefined()
    expect(withPreset({ colId: 'status' }, live, false).hide).toBe(true)
    expect(withPreset({ colId: 'supervisor' }, live, true).hide).toBe(false)
    expect(withPreset({ colId: 'supervisor' }, live, false).hide).toBe(true)
  })
  it('a row picks the dock\'s order (its own thread); the tab is drawn by the page (R5)', () => {
    expect(pickOfRow({ id: 'o1', number: 'SO-2026-0142', companyId: 'c1' })).toEqual({ type: 'SalesOrder', id: 'o1', label: 'SO-2026-0142', companyId: 'c1' })
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    expect(view).toContain("{tab === 'work' && work}")
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("keep: ['tab', 'dock']")
    expect(tab).toContain('listKey: ORDERS_LIST_KEY')
    expect(tab).toContain('/production/work-orders?party=')
  })
})

describe('F-SA-276: the waiting strip', () => {
  it('"—" while reading (never 0), 0 is an answer, a capped read says "100+", a failed read only on its tile', () => {
    expect(valueOf(tileOf('late', reads()))).toBe('—')
    expect(valueOf(tileOf('late', reads({ board: board({ late: 0, waitingForDeposit: 2, waitingForCustomer: 0 }) })))).toBe('0')
    expect(valueOf(tileOf('deposit', reads({ board: board({ late: 0, waitingForDeposit: 2, waitingForCustomer: 0 }) })))).toBe('2')
    expect(valueOf(tileOf('replies', reads({ replies: { status: 'ready', value: { rows: [], count: 100, complete: false } } })))).toBe('100+')
    const failed = reads({ requests: { status: 'failed' }, board: board({ late: 1 }) })
    expect(tileOf('requests', failed)).toEqual({ status: 'failed' })
    expect(tileOf('late', failed)).toEqual({ status: 'ready', count: 1, more: false })
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
    const strip = readFileSync(new URL('./view/WaitingStrip.tsx', import.meta.url), 'utf8')
    expect(strip).toContain("(tile === 'customer' || tile === 'tasks') && doors.onWindow")
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
  const block = hook.slice(hook.indexOf('export function useCustomerDock'))
  it('a replace, never a push (Back leaves the page); the summary read checks an address\'s record', () => {
    // F-OP-211: the record pages' ONE history writer (a replace, only a different address); no router write of `dock=` any more.
    expect(block).toContain('writeSearch(dockAddress(pathname, window.location.search, next, messageId))')
    expect(block).not.toContain('router.replace')
    expect(block).not.toContain('router.push')
    expect(block).not.toContain('push: true')
    expect(block).toContain('readRecordSummary(api, { type: term.type, id: term.id }, controller.signal)')
    expect(block).toContain('if (!checked) return write(GENERAL_DOCK)')
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
    expect(WORK_VIEWS).toEqual(['all', 'IN_PRODUCTION', WAITING_US_VIEW, 'late', DRAFTS_VIEW, NOT_EQUAL_VIEW])
    expect(workViewsOf({ price: true }, { drafts: true, priceCheck: true })).toEqual([...WORK_VIEWS])
    expect(workViewsOf({ price: false }, { drafts: true, priceCheck: true })).toEqual(['all', 'IN_PRODUCTION', WAITING_US_VIEW, 'late', DRAFTS_VIEW])
    expect(workViewsOf({ price: true })).toEqual(['all', 'IN_PRODUCTION', WAITING_US_VIEW, 'late'])
  })

  it('the empty state per view: All orders says no order yet; In production keeps its way to All orders; other views the sheet\'s own', () => {
    const t = createTranslator('en', messagesFor('en', ['parties']).parties!)
    expect(workEmptyOf('all', null, 'Brand Alpha', t, '/all')).toEqual({ title: 'Brand Alpha has no order yet.', view: 'all', newOrder: true /* F-CP-104 */ })
    expect(workEmptyOf('IN_PRODUCTION', null, 'Brand Alpha', t, '/all')).toEqual({ title: 'Nothing in production for Brand Alpha.', link: { href: '/all', label: 'Show all orders' }, view: 'IN_PRODUCTION' })
    expect(workEmptyOf('late', null, 'Brand Alpha', t, '/all')).toBeNull()
    expect(workEmptyOf('open', 'us', 'Brand Alpha', t, '/all')).toBeNull()
    expect(createTranslator('it', messagesFor('it', ['parties']).parties!)('customers.work.emptyAll', { customer: 'Brand Alpha' })).toBe('Brand Alpha non ha ancora ordini.')
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

  it('Open orders → rows=open, In production → status=IN_PRODUCTION, Late → late=true (the views the tiles count)', () => {
    expect(workDoor(RECORD, 'open')).toBe(`${RECORD}?tab=work&rows=open`)
    expect(workDoor(RECORD, 'inProduction')).toBe(`${RECORD}?tab=work&status=IN_PRODUCTION`)
    expect(workDoor(RECORD, 'late')).toBe(`${RECORD}?tab=work&late=true`)
    expect([viewOf(workDoor(RECORD, 'open')), viewOf(workDoor(RECORD, 'inProduction')), viewOf(workDoor(RECORD, 'late'))]).toEqual(['open', 'IN_PRODUCTION', 'late'])
    // The rows each door reads are the rows its tile counts: Open = the open states, Late = open and promised before today.
    expect([...OPEN_ORDERS].sort()).toEqual([...OPEN_STATUSES].sort())
    expect(rowsQuery('open', '', null, ALPHA)).toMatchObject({ open: true, partyId: ALPHA })
    expect(rowsQuery('IN_PRODUCTION', '', null, ALPHA)).toMatchObject({ status: 'IN_PRODUCTION', partyId: ALPHA })
    expect(rowsQuery('late', '', null, ALPHA)).toMatchObject({ late: true, partyId: ALPHA })
    const view = readFileSync(new URL('./view/CustomerRecordView.tsx', import.meta.url), 'utf8')
    for (const door of ['open', 'inProduction', 'late']) expect(view).toContain(`href: workDoor(recordHref, '${door}')`)
  })

  it('a door arrives with its view: the entry adds the lock once and no default beside the view (fx-12)', () => {
    for (const door of ['open', 'inProduction', 'late'] as const) {
      const query = workDoor(BASE, door).split('?')[1]!
      const once = workEntry(BASE, ALPHA, params(query))!
      const written = new URL(`https://x${once}`).searchParams
      expect(written.get('party'), door).toBe(ALPHA)
      expect(written.getAll('rows').length + written.getAll('status').length + written.getAll('late').length, door).toBe(1)
      expect(workEntry(BASE, ALPHA, params(once.split('?')[1]!)), door).toBeNull()
    }
  })

  it('the counts: All orders (every state), In production, Late from the strip\'s board read; nothing while it reads; Waiting on us no number', () => {
    expect(workViewCounts({ status: 'reading' })).toBeNull()
    expect(workViewCounts({ status: 'failed' })).toBeNull()
    const ready = { status: 'ready' as const, value: { byStatus: [{ status: 'CONFIRMED', count: 3 }, { status: 'IN_PRODUCTION', count: 7 }, { status: 'CLOSED', count: 32 }], lanes: [], tiles: [{ key: 'late', count: 2, filter: {} }], asOf: '2026-11-19T10:00:00Z' } } as never
    const counts = workViewCounts(ready)!
    expect(counts).toEqual({ all: 42, IN_PRODUCTION: 7, late: 2 })
    const orders = createTranslator('en', messagesFor('en', ['orders']).orders!)
    const sheet = createTranslator('en', messagesFor('en', ['orders-sheet'])['orders-sheet']!)
    const items = builtInViewsOf({ customer: { id: ALPHA, name: 'Brand Alpha' }, locked: { party: true, kind: false }, views: workViewsOf({ price: true }), viewCounts: counts }, orders, sheet)
    expect(items.map((item) => [item.label, item.count ?? null])).toEqual([['All orders', '42'], ['In production', '7'], ['Waiting on us', null], ['Late', '2']])
    // The page names the customer: no "Orders of Brand Alpha" line under each item on its own page.
    expect(items.some((item) => item.hint)).toBe(false)
  })

  it('no second read: the Work tab hands the sheet the strip\'s read (brand wall: the API walls it to this customer)', () => {
    const tab = readFileSync(new URL('./view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('viewCounts: workViewCounts(work.reads.board)')
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
