import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { LIST_ROWS } from '../_demo/fixtures'
import type { OrderRow } from '../api'
import { listAddress } from '../model'
import { CLEAR_DROPS, lockedEntry, ORDERS_LIST_KEY, sheetAddress, sheetPartyOf, useOrdersSheet, type OrdersSheetHost } from './use-orders-sheet'

/**
 * F-SA-220 (sales page plan N7 / N5, picks R9, P10, P12, P18; 17-review C-2 and the SHEET-G02 lesson): the ONE Orders sheet. A host's
 * locks are in every read and in the address (Export ▾, saved views and Pin to Today take the address's terms), never cleared; the
 * host's own terms stay when the sheet writes; the list key is 'sales.orders' on every host; a row's click is the host's; Sales ›
 * Orders behaves as before. The hook is drawn on the server (no effects run): its model is read, and its actions are called after.
 */

const nav = vi.hoisted(() => ({ search: '', replaced: [] as string[], pushed: [] as string[] }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (to: string) => nav.replaced.push(to), push: (to: string) => nav.pushed.push(to), refresh() {} }),
  useSearchParams: () => new URLSearchParams(nav.search),
  usePathname: () => '/w/DEMO/sales/somewhere-else',
}))
const world = vi.hoisted(() => {
  const company = { id: '0190f0e2-c0c0-7000-8000-000000000001', code: 'DEMO', name: 'Demo company' }
  return {
    session: {
      user: { id: '0190f0e2-0000-7000-8000-0000000000aa', email: 'person@example.com', displayName: 'Bea Esempio', locale: 'en' },
      tenant: { id: '0190f0e2-0000-7000-8000-0000000000bb', slug: 'demo', name: 'Demo' },
      company,
      companies: [company],
      sites: [],
      permissions: ['orders.view', 'orders.manage', 'threads.read', 'sales.measurements.view'],
      mfa: { enabled: false, required: false, satisfied: true },
    },
    // The reads start in effects (none run here): an answer that never comes.
    api: { get: () => new Promise(() => undefined), post: () => new Promise(() => undefined), put: () => new Promise(() => undefined) },
  }
})
vi.mock('../../../../lib/session/context', () => ({ useOfficeSession: () => world.session, useOfficeApi: () => world.api }))

const ALPHA = '0190f0e2-a1fa-7000-8000-000000000001'
const BETA = '0190f0e2-be7a-7000-8000-000000000002'

let sheet: ReturnType<typeof useOrdersSheet> | null = null
function Probe({ host }: { host: OrdersSheetHost }) {
  sheet = useOrdersSheet(host)
  return null
}
function draw(host: OrdersSheetHost, search = '') {
  nav.search = search
  sheet = null
  renderToString(createElement(I18nProvider, { locale: 'en', messages: {} }, createElement(Probe, { host })))
  return sheet!
}
const params = (search: string) => new URLSearchParams(search)

beforeEach(() => {
  nav.replaced = []
  nav.pushed = []
})

describe('a host\'s locks are in the address and every read, never cleared (F-SA-220)', () => {
  it('the party every read narrows to is the host\'s lock, whatever the address says', () => {
    expect(sheetPartyOf({ locked: { party: ALPHA } }, params(`party=${BETA}`))).toBe(ALPHA)
    expect(sheetPartyOf({}, params(`party=${BETA}`))).toBe(BETA)
    expect(sheetPartyOf({}, params(''))).toBeNull()
    const model = draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA } }, `party=${BETA}`).model
    expect(model.customer?.id).toBe(ALPHA)
  })

  it('on entry the address gets the locks it lacks (a view applied without them gets them back); with them nothing is written', () => {
    expect(lockedEntry('/w/DEMO/sales/made-to-measure', { locked: { kind: 'mtm' } }, params('rows=all'))).toBe('/w/DEMO/sales/made-to-measure?rows=all&kind=mtm')
    expect(lockedEntry('/w/DEMO/sales/made-to-measure', { locked: { kind: 'mtm' } }, params('kind=mtm&rows=all'))).toBeNull()
    expect(lockedEntry(`/w/DEMO/sales/customers/${ALPHA}`, { locked: { party: ALPHA } }, params(`tab=work&party=${BETA}`))).toBe(`/w/DEMO/sales/customers/${ALPHA}?tab=work&party=${ALPHA}`)
    expect(lockedEntry('/w/DEMO/sales/orders', {}, params(''))).toBeNull()
  })

  it('every address the sheet writes keeps the locks and the host\'s own terms (Clear all, a tile, the search, the customer\'s ✕)', () => {
    const host: OrdersSheetHost = { basePath: '/sales/made-to-measure', locked: { kind: 'mtm' }, keep: ['segment'] }
    const { actions } = draw(host, 'kind=mtm&segment=orders&q=SO-1')
    actions.onRows?.('late')
    actions.onClearAll?.()
    actions.onSearch?.('rider')
    actions.onCustomer?.(null)
    expect(nav.replaced).toHaveLength(4)
    for (const to of nav.replaced) {
      const written = new URL(to, 'https://factory.example.com')
      expect(written.pathname, to).toBe('/w/DEMO/sales/made-to-measure')
      expect(written.searchParams.get('kind'), to).toBe('mtm')
      expect(written.searchParams.get('segment'), to).toBe('orders')
    }
    expect(new URL(nav.replaced[0]!, 'https://factory.example.com').searchParams.get('late')).toBe('true')
    // Clear all clears the sheet's own terms, never the lock.
    expect(new URL(nav.replaced[1]!, 'https://factory.example.com').searchParams.get('q')).toBeNull()

    nav.replaced = []
    const customer = draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA }, keep: ['tab'] }, `party=${ALPHA}&tab=work`)
    customer.actions.onCustomer?.(BETA)
    customer.actions.onClearAll?.()
    for (const to of nav.replaced) {
      const written = new URL(to, 'https://factory.example.com')
      expect(written.searchParams.get('party'), to).toBe(ALPHA)
      expect(written.searchParams.get('tab'), to).toBe('work')
    }
    expect(sheetAddress('/w/DEMO/x', { locked: { party: ALPHA, kind: 'mtm' }, keep: ['tab', 'dock'] }, params('tab=work&dock=SalesOrder.1&other=1'), { rows: 'open', q: '', layout: 'list', party: BETA })).toBe(`/w/DEMO/x?party=${ALPHA}&kind=mtm&tab=work&dock=SalesOrder.1`)
  })

  it('a locked customer draws no switcher and no customer chip; the model says what is locked', () => {
    const model = draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA } }, `party=${ALPHA}`).model
    expect(model.switcher).toBeNull()
    expect(model.locked).toEqual({ party: true, kind: false })
    const orders = draw({ basePath: '/sales/orders' }).model
    expect(orders.switcher).not.toBeNull()
    expect(orders.locked).toEqual({ party: false, kind: false })
  })
})

describe('one list key, the host\'s row click, the session\'s prefix (F-SA-220)', () => {
  it('the list key is \'sales.orders\' on every host (one export source, one set of saved views)', () => {
    expect(ORDERS_LIST_KEY).toBe('sales.orders')
    for (const host of [{ basePath: '/sales/orders' }, { basePath: '/sales/made-to-measure', locked: { kind: 'mtm' as const }, embedded: true }, { basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA } }]) expect(draw(host).model.listKey, host.basePath).toBe('sales.orders')
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('listKey={model.listKey')
  })

  it('the company prefix comes from the session, not from the path', () => {
    // The mocked path is not an Orders page: the prefix is still /w/DEMO.
    expect(draw({ basePath: '/sales/made-to-measure' }).model.prefix).toBe('/w/DEMO')
  })

  it('a row\'s click is the host\'s (the customer page docks it); by default the order opens', () => {
    const clicked: Array<[string, boolean]> = []
    const host: OrdersSheetHost = { basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA }, onRowClick: (row: OrderRow, newTab) => clicked.push([row.id, newTab]) }
    const docked = draw(host, `party=${ALPHA}`)
    // No row is loaded in a server render: the click has no row to hand over and falls back to opening the order.
    docked.actions.onOpenRow?.(LIST_ROWS[0]!.id, false)
    expect(nav.pushed).toEqual([`/w/DEMO/sales/orders/${LIST_ROWS[0]!.id}`])
    expect(clicked).toEqual([])
    nav.pushed = []
    draw({ basePath: '/sales/orders' }).actions.onOpenRow?.('0190f0e2-0000-7000-8000-000000000042', false)
    expect(nav.pushed).toEqual(['/w/DEMO/sales/orders/0190f0e2-0000-7000-8000-000000000042'])
    const source = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (host.onRowClick && row) return host.onRowClick(row, newTab)')
  })

  it('an embedding host gets no band and no tiles from the view, and no New order key (the host draws them)', () => {
    expect(draw({ basePath: '/sales/made-to-measure', embedded: true }).model.embedded).toBe(true)
    expect(draw({ basePath: '/sales/orders' }).model.embedded).toBe(false)
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{!model.embedded && (')
    expect(view).toContain('{!model.embedded && <TilesStrip')
    expect(view).toContain('export function OrdersTiles(')
    expect(view).toContain('export function OrdersLayoutSwitch(')
  })
})

describe('Sales › Orders behaves as before (F-SA-220)', () => {
  it('its addresses are the list\'s own: nothing added, nothing kept that the page did not write', () => {
    const next = { rows: 'late' as const, q: 'SO-1', layout: 'board' as const, party: BETA, brand: 'own', company: null }
    expect(sheetAddress('/w/DEMO/sales/orders', {}, params('segment=x&tab=y'), next)).toBe(listAddress('/w/DEMO/sales/orders', next))
    const { actions, model } = draw({ basePath: '/sales/orders' }, `party=${BETA}&q=SO-1`)
    expect(model.customer?.id).toBe(BETA)
    actions.onCustomer?.(null)
    expect(nav.replaced).toEqual(['/w/DEMO/sales/orders?q=SO-1'])
    const page = readFileSync(new URL('./OrdersPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("useOrdersSheet({ basePath: '/sales/orders' })")
    expect(page.split('\n').length).toBeLessThan(30)
  })
})

// ---- F-CP-102 (customer page plan C1; 10-customer-page §1): Clear all goes back to the host's default ------------------------------
// The host says its default view (`clearTo`, default Open orders): Clear all writes it (All orders on the customer page, Open orders on
// Sales › Orders), drops the Work · Money columns term (CLEAR_DROPS) and the door terms, never the lock or the host's tab; the model's
// `defaultRows` is the host's (no chip, the "Showing" line compares with it).
describe('F-CP-102: Clear all goes back to the host\'s default view', () => {
  it('the customer page: rows=all, the columns term and every narrowing gone; the lock, the tab and the dock stay', () => {
    const host: OrdersSheetHost = { basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA }, keep: ['tab', 'dock', 'cols'], clearTo: 'all' }
    const { actions, model } = draw(host, `party=${ALPHA}&tab=work&dock=all&status=IN_PRODUCTION&cols=money&q=giacca&atRisk=true`)
    expect(model.defaultRows).toBe('all')
    actions.onClearAll?.()
    const written = new URL(nav.replaced[0]!, 'https://factory.example.com').searchParams
    expect(written.get('rows')).toBe('all')
    for (const gone of ['status', 'cols', 'q', 'atRisk']) expect(written.has(gone), gone).toBe(false)
    expect([written.get('party'), written.get('tab'), written.get('dock')]).toEqual([ALPHA, 'work', 'all'])
  })

  it('Sales › Orders keeps Open orders: Clear all writes no rows term (Open is its default), its model has no host default', () => {
    const { actions, model } = draw({ basePath: '/sales/orders' }, 'late=true&q=SO-1')
    expect(model.defaultRows).toBeNull()
    actions.onClearAll?.()
    expect(nav.replaced).toEqual(['/w/DEMO/sales/orders'])
  })

  it('a kept term is dropped only where a write names it (CLEAR_DROPS); every other write keeps it', () => {
    expect(CLEAR_DROPS).toEqual(['cols'])
    const host = { locked: { party: ALPHA }, keep: ['tab', 'cols'] }
    const now = params(`tab=work&cols=money&party=${ALPHA}`)
    const next = { rows: 'late' as const, q: '', layout: 'list' as const, party: null }
    expect(new URL(sheetAddress('/w/DEMO/x', host, now, next), 'https://x').searchParams.get('cols')).toBe('money')
    const cleared = new URL(sheetAddress('/w/DEMO/x', host, now, next, CLEAR_DROPS), 'https://x').searchParams
    expect(cleared.has('cols')).toBe(false)
    expect([cleared.get('tab'), cleared.get('party')]).toEqual(['work', ALPHA])
  })
})
// ---- end F-CP-102

// ---- F-CP-104 (customer page plan C2a; review A9): the New order window on a host that holds the customer ---------------------------
describe('F-CP-104: New order on the customer page holds its customer', () => {
  it('an old ?new=1 opens the window on arrival; on the customer page it holds the customer (no Change), on Sales › Orders it does not', () => {
    const customer = draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA }, keep: ['tab'] }, `party=${ALPHA}&tab=work&new=1`).model
    expect(customer.newOrder?.partyLocked).toBe(true)
    const orders = draw({ basePath: '/sales/orders' }, `party=${BETA}&new=1`).model
    expect(orders.newOrder?.partyLocked).toBe(false)
    expect(draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA } }, `party=${ALPHA}`).model.newOrder).toBeNull()
  })

  it('New order on a host that holds the customer reads that customer at once (no search); nothing is written into the address', () => {
    const asked: string[] = []
    const before = world.api.get
    world.api.get = ((path: string) => (asked.push(path), new Promise(() => undefined))) as typeof world.api.get
    try {
      draw({ basePath: `/sales/customers/${ALPHA}`, locked: { party: ALPHA }, keep: ['tab'] }, `party=${ALPHA}&tab=work`).actions.onNewOrder?.(true)
    } finally {
      world.api.get = before
    }
    expect(asked.some((path) => path.includes(ALPHA))).toBe(true)
    expect(nav.replaced).toEqual([])
    expect(nav.pushed).toEqual([])
  })

  it('the window: no Change and no search while it holds the customer; its button says "Add the lines" (draft stays the portal\'s word)', () => {
    const window = readFileSync(new URL('./view/NewOrderDialog.tsx', import.meta.url), 'utf8')
    expect(window).toContain('{!model.partyLocked && (')
    expect(window).toContain('{!party && model.partyLocked ? (')
    expect(window).toContain("t('newOrder.addLines')")
    const sheet = readFileSync(new URL('./use-orders-sheet.ts', import.meta.url), 'utf8')
    expect(sheet).toContain('party: current.partyLocked ? current.party : null')
    for (const locale of ['en', 'it'] as const) {
      const catalogue = JSON.parse(readFileSync(new URL(`../../../../../messages/${locale}/orders.json`, import.meta.url), 'utf8')) as { newOrder: Record<string, unknown> }
      expect(catalogue.newOrder.addLines, locale).toBe(locale === 'en' ? 'Add the lines' : 'Aggiungi le righe')
      expect(catalogue.newOrder.create, `${locale}: the old words are gone`).toBeUndefined()
    }
  })

  it('All orders with none yet offers New order in place, held with why without orders.manage', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view).toContain(") : hostEmpty.newOrder ? (")
    expect(view).toContain("heldReason={model.can.manage ? null : t('held.noManage')} onClick={() => actions?.onNewOrder?.(true)}")
  })
})
// ---- end F-CP-104
