import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { viewQuery } from '@nexus/factory-domain/views/state'
import { LOCALES } from '../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../lib/i18n/messages'
import { rowsQuery, listAddress } from '../../orders/model'
import { sheetAddress } from '../../orders/list/use-orders-sheet'
import { builtInActive, builtInViewsOf, pickBuiltIn, WAITING_US_VIEW, withPreset } from '../../orders/list/view/OrdersListView'
import { marksOf, sourcesTouched, STRIP_GROUPS, tileOf, tilesShown, workAttention, workEntry, WORK_DEFAULT_ROWS, type WorkReads } from './use-customer-work'
import { valueOf } from './view/WaitingStrip'
import { pickOfRow, WORK_VIEWS, workPreset } from './view/WorkTab'

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
  it('no view term: the default view (In production), the tab and the lock — one write', () => {
    const entry = workEntry(BASE, ALPHA, params(''))!
    const written = new URL(`https://x${entry}`).searchParams
    expect(written.get('tab')).toBe('work')
    expect(written.get('party')).toBe(ALPHA)
    expect(written.get('status')).toBe(WORK_DEFAULT_ROWS)
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
  it('In production · Waiting on us · Late · All orders, in that order; Sales › Orders keeps its own list (no Waiting on us unasked)', () => {
    expect(builtInViewsOf({ customer: null, views: WORK_VIEWS }, orders, sheet).map((view) => view.label)).toEqual(['In production', 'Waiting on us', 'Late', 'All orders'])
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
