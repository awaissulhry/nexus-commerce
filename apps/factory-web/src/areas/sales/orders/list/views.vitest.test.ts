import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor, placeholdersOf } from '../../../../lib/i18n/messages'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { columnsMenuItems, type ColumnsMenuActions } from '../../../../list-frame/tools/ListToolsBar'
import { SaveViewDialog } from '../../../../list-frame/tools/dialogs'
import { screenState } from '../../../../list-frame/tools/model'
import type { SavedView, ViewsAnswer } from '../../../../list-frame/tools/transport'
import { ROW_VIEWS } from '../model'
import { exportAbout, NAMESPACE } from './sheet/model'
import { builtInViewsOf } from './view/OrdersListView'
// ---- F-CP-102 ----
import { readFileSync } from 'node:fs'
import { builtInActive, homeOf, hostEmptyOf, pickBuiltIn, showingOf } from './view/OrdersListView'
// ---- end F-CP-102

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so the dialog's words are checked.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * B-TH-243 (threads plan TH-4, picture 25; features SHEET.brand-view-F01 … F05, ORD-G10; wall W18, W19, W30): a customer's own
 * sheet — Save view as keeps the customer (`?party=`) and starts from its name, someone else's view changed on my screen is saved
 * as my own (never altered), ONE Views menu with the Orders' built-in views on top, and the file named after the customer.
 */

const ALPHA = '0190f0e2-aaaa-7000-8000-000000000001'
const tFor = (locale: (typeof LOCALES)[number], namespace: string) => createTranslator(locale, messagesFor(locale, [namespace])[namespace]!)
const lists = tFor('en', 'lists')
const orders = tFor('en', 'orders')
const sheet = tFor('en', NAMESPACE)

const act: ColumnsMenuActions = { apply: () => undefined, reload: () => undefined, save: () => undefined, update: () => undefined, edit: () => undefined, copy: () => undefined, remove: () => undefined, setDefault: () => undefined, customise: () => undefined }
const view = (over: Partial<SavedView> = {}): SavedView => ({ id: 'v1', listKey: 'sales.orders', name: 'Brand Alpha — tracking', ownerId: 'u2', ownerName: 'Demo Lead', mine: false, audience: 'ROLE', roleId: 'r1', roleName: 'Account team', roleDefault: false, personalDefault: false, state: { query: `party=${ALPHA}` }, changeHeld: 'Only its owner may change it.', version: 1, ...over })
const answer = (views: SavedView[]): ViewsAnswer => ({ views, roleDefaultId: null, personalDefaultId: null, roles: [{ id: 'r1', name: 'Account team' }], allRoles: [], can: { save: true, manage: false, export: true }, exports: { formats: ['XLSX', 'CSV'] } })

describe('one Views menu: the built-in views on top (ORD-G10)', () => {
  const builtIns = { items: builtInViewsOf({ customer: null }, orders, sheet), active: 'late', onPick: () => undefined }

  it('the Orders\' rows views are the built-ins, in the rows\' order, each named by the orders catalogue', () => {
    expect(builtIns.items.map((item) => item.id)).toEqual([...ROW_VIEWS, 'kind:mtm']) // F-SA-221: + Made-to-measure
    expect(builtIns.items.find((item) => item.id === 'open')?.label).toBe(orders('rows.open'))
    // On a customer's sheet each says whose orders it shows.
    expect(builtInViewsOf({ customer: { id: ALPHA, name: 'Brand Alpha' } }, orders, sheet)[0]?.hint).toBe('Orders of Brand Alpha')
  })

  it('the menu starts with them (the active one ticked), then the saved views, then Customise', () => {
    const items = columnsMenuItems(lists, { answer: answer([]), problem: null, active: null, changed: false, asBuilt: true, builtIns }, act)
    expect(items[0]).toMatchObject({ id: 'h-builtin', heading: true, label: 'Built-in views' })
    expect(items.find((item) => item.id === 'b-late')?.checked).toBe(true)
    expect(items.find((item) => item.id === 'b-open')?.checked).toBe(false)
    const ids = items.map((item) => item.id)
    expect(ids.indexOf('b-all')).toBeLessThan(ids.indexOf('h-views'))
    expect(ids.indexOf('h-views')).toBeLessThan(ids.indexOf('customise'))
  })

  it('a list without built-ins keeps its menu exactly (Views first)', () => {
    const items = columnsMenuItems(lists, { answer: answer([]), problem: null, active: null, changed: false, asBuilt: true }, act)
    expect(items[0]).toMatchObject({ id: 'h-views' })
    expect(items.some((item) => item.id.startsWith('b-'))).toBe(false)
  })
})

describe('a customer\'s own sheet (SHEET.brand-view-F01, F03)', () => {
  it('Save view as keeps the customer: the view\'s terms hold ?party= (the transient ones dropped)', () => {
    expect(screenState(`party=${ALPHA}&late=true&cursor=abc`, {}).query).toBe(`late=true&party=${ALPHA}`)
  })

  it('the name starts as the customer\'s ("Brand Alpha — tracking"), in both languages', () => {
    for (const locale of LOCALES) {
      const t = tFor(locale, NAMESPACE)
      expect(t('views.suggest', { customer: 'Brand Alpha' })).toContain('Brand Alpha')
      const html = renderToString(
        createElement(I18nProvider, { locale, messages: messagesFor(locale, ['lists', 'shell']) }, createElement(SaveViewDialog, { view: null, answer: answer([]), state: { query: `party=${ALPHA}` }, busy: false, problem: null, link: null, onCopy: () => undefined, onSave: () => undefined, onClose: () => undefined, suggested: t('views.suggest', { customer: 'Brand Alpha' }) })),
      )
      expect(html).toContain(`value="${t('views.suggest', { customer: 'Brand Alpha' })}"`)
    }
  })

  it('someone else\'s view changed on my screen: "Changed · Save as your own" (it is never altered); unchanged: no such line', () => {
    const shared = view()
    const changed = columnsMenuItems(lists, { answer: answer([shared]), problem: null, active: shared, changed: true, asBuilt: false }, act)
    expect(changed.find((item) => item.id === 'saveOwn')?.label).toBe('Changed · Save as your own')
    expect(changed.some((item) => item.id === 'update')).toBe(false)
    const same = columnsMenuItems(lists, { answer: answer([shared]), problem: null, active: shared, changed: false, asBuilt: false }, act)
    expect(same.some((item) => item.id === 'saveOwn')).toBe(false)
    // My own view changed: Update, never "Save as your own".
    const mine = view({ mine: true, changeHeld: null, ownerId: 'me' })
    const own = columnsMenuItems(lists, { answer: answer([mine]), problem: null, active: mine, changed: true, asBuilt: false }, act)
    expect(own.some((item) => item.id === 'saveOwn')).toBe(false)
    expect(own.some((item) => item.id === 'update')).toBe(true)
  })

  it('the file is named after the customer and says it holds that customer\'s orders only', () => {
    expect(sheet('export.title', { customer: 'Brand Alpha' })).toBe('Orders - Brand Alpha')
    const about = exportAbout(sheet, { customer: 'Brand Alpha', view: orders('rows.open'), count: 42, price: true, formats: ['XLSX'] })
    expect(about.heading).toContain('Brand Alpha')
    expect(about.formats.XLSX).toContain('42')
  })

  it('the words exist in it and en with the same placeholders', () => {
    for (const key of ['views.suggest', 'views.ofCustomer']) {
      const en = CATALOGUE.en[NAMESPACE]?.[key] ?? ''
      const it_ = CATALOGUE.it[NAMESPACE]?.[key] ?? ''
      expect(en, key).not.toBe('')
      expect(placeholdersOf(it_), key).toEqual(placeholdersOf(en))
    }
    for (const key of ['tools.builtIn', 'tools.viewsTrigger', 'tools.saveOwn', 'tools.saveOwnHint']) for (const locale of LOCALES) expect(CATALOGUE[locale].lists?.[key], `${locale} ${key}`).toBeTruthy()
  })
})

// ---- F-CP-102 (customer page plan C1; 10-customer-page §1): the host's own views in Views ▾, and the host's default view -------------
describe('F-CP-102: host views in Views ▾; the "Showing" line and the empty words compare with the host\'s default', () => {
  const DRAFTS = 'drafts:customer'
  const hostViews = [{ id: DRAFTS, label: 'Drafts of Brand Alpha' }]

  it('a host view sits where the host\'s views name it, with the host\'s words; a sheet without views never shows it', () => {
    expect(builtInViewsOf({ customer: null, views: ['all', 'IN_PRODUCTION', DRAFTS], hostViews }, orders, sheet).map((item) => item.label)).toEqual([orders('rows.all'), orders('rows.IN_PRODUCTION'), 'Drafts of Brand Alpha'])
    expect(builtInViewsOf({ customer: null, hostViews }, orders, sheet).some((item) => item.id === DRAFTS)).toBe(false)
  })

  it('picked: a host view goes to the host, a rows view to the sheet; active: the host view the address shows wins', () => {
    const calls: unknown[][] = []
    const actions = { onRows: (...args: unknown[]) => calls.push(['rows', ...args]), onWaiting: (...args: unknown[]) => calls.push(['waiting', ...args]), onKind: (...args: unknown[]) => calls.push(['kind', ...args]), onHostView: (...args: unknown[]) => calls.push(['host', ...args]) }
    pickBuiltIn(DRAFTS, { waiting: null, hostViews }, actions)
    pickBuiltIn('late', { waiting: null, hostViews }, actions)
    expect(calls).toEqual([['host', DRAFTS], ['rows', 'late']])
    expect(builtInActive({ rows: 'all', kind: null, waiting: null, hostViews: [{ ...hostViews[0]!, active: true }] })).toBe(DRAFTS)
    expect(builtInActive({ rows: 'all', kind: null, waiting: null, hostViews })).toBe('all')
  })

  it('"Showing: …" names any view but the host\'s default: rows=open on the customer page says Open; Sales › Orders as before', () => {
    expect(homeOf({ defaultRows: 'all' })).toBe('all')
    expect(homeOf({})).toBe('open')
    expect(showingOf({ rows: 'open', defaultRows: 'all', layout: 'list' })).toBe('open')
    expect(showingOf({ rows: 'all', defaultRows: 'all', layout: 'list' })).toBeNull()
    expect(showingOf({ rows: 'IN_PRODUCTION', defaultRows: 'all', layout: 'list' })).toBe('IN_PRODUCTION')
    expect(showingOf({ rows: 'open', layout: 'list' })).toBeNull()
    expect(showingOf({ rows: 'all', layout: 'list' })).toBe('all')
    expect(showingOf({ rows: 'late', layout: 'week' })).toBeNull()
    expect(orders('list.viewing', { view: orders('rows.open') })).toContain(orders('rows.open'))
  })

  it('the host\'s empty words: keyed to a view, they show on it unless something else narrows; unkeyed, only when nothing narrows', () => {
    const keyed = { title: 'Nothing in production for Brand Alpha.', view: 'IN_PRODUCTION' as const }
    expect(hostEmptyOf({ rows: 'IN_PRODUCTION', empty: keyed }, true, false)).toBe(keyed)
    expect(hostEmptyOf({ rows: 'IN_PRODUCTION', empty: keyed }, true, true)).toBeNull()
    expect(hostEmptyOf({ rows: 'late', empty: keyed }, true, false)).toBeNull()
    const unkeyed = { title: 'Made-to-measure has not started.' }
    expect(hostEmptyOf({ rows: 'open', empty: unkeyed }, false, false)).toBe(unkeyed)
    expect(hostEmptyOf({ rows: 'late', empty: unkeyed }, true, false)).toBeNull()
  })

  it('a view chip\'s ✕ goes back to the host\'s default (the source)', () => {
    const source = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(source).toContain('onClear: () => actions?.onRows?.(home)')
    expect(source).toContain('const hostEmpty = hostEmptyOf(model, narrowed, othersNarrowed)')
  })
})
// ---- end F-CP-102
