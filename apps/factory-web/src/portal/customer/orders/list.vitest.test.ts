import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../lib/api/client'
import type { DesignScreen } from '../../../lib/design/design-screen'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { ORDER_STATUS_TONE } from '../../../lib/order-cells/model'
import { CUSTOMER_GROUP_ICON, CUSTOMER_GROUPS } from '../../../lib/order-groups/groups'
import { PICTURE_ROUTES } from '../../../lib/record-picture/api'
import { scanText } from '../../../lib/testing/brand-scan'
import { BRAND_ALPHA } from '../../../lib/testing/two-brands'
import { REQUESTS, requestRow } from '../requests/design-data'
import { fetchSheet, type OrdersRead } from './api'
import { BETA_ROWS, betaOrdersRead, ordersRead, ROWS } from './design-data'
import { designScreen as listScreen } from './fixtures'
import { bandOf, countOf, groupOfAddress, groupQuery, holdsOrders, LIST_WIDTHS, listRowsOf, nextParcelOf, requestsOf, roomColumnsOf, rowViewOf, sheetChipOf, type ListWords } from './list-view-model'
import { NS, type ListRow } from './model'
import { dayWriter } from './words'

/**
 * pg-t (portal grid plan § 5 pg-3.x / pg-4; 18-lead-settles Z3–Z8, Z16; 10-design § 1–§ 4) — the customer's Orders & requests on the
 * shared parts: the rows as the shared cells' view models, a door in every cell (a catalogue request plain), the band's numbers ONLY
 * the server's ("—" while read), two customers each with their own band (W05 / W10), no office series anywhere (the parcel named by
 * its order, D6), the columns that join by the room (D8, Z16 P1), every word in both languages. Made-up data only.
 */

const wordsFor = (locale: (typeof LOCALES)[number]): ListWords => ({
  t: createTranslator(locale, CATALOGUE[locale][NS] ?? {}),
  list: createTranslator(locale, CATALOGUE[locale]['order-list'] ?? {}),
  locale,
  day: dayWriter(locale),
  money: (minor, currency) => (minor == null ? '—' : `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim()),
})
const EN = wordsFor('en')
const PREFIX = '/p/BETA'
const order = (row = BETA_ROWS[0]!): ListRow => ({ kind: 'order', id: row.id, order: row })
const viewOf = (row: ListRow, seesPrices = true) => rowViewOf(row, { prefix: PREFIX, seesPrices, words: EN })
const OFFICE_SERIES = /\b(?:SO|RQ|SH|INQ|QT)-\d{4}-\d+/

describe('pg-t: the rows on the shared cells', () => {
  it('an order: "Your order 21" over your PO, its picture, the status chip in the office\'s tone, every cell a door', () => {
    const row = BETA_ROWS[0]! // partly shipped, its promise moved, a parcel on the way
    const view = viewOf(order(row))
    expect(view).toMatchObject({ kind: 'order', href: `${PREFIX}/orders/${row.id}?tab=overview`, picture: true })
    expect(view.number).toEqual({ text: row.yourNumber!.words.en, sub: `Your PO ${row.customerRef}`, door: { href: `${PREFIX}/orders/${row.id}?tab=overview`, tip: { key: 'row.open' } } })
    expect(view.state).toEqual({ words: row.words.en, tone: ORDER_STATUS_TONE.PARTLY_SHIPPED, mark: CUSTOMER_GROUP_ICON.SHIPPED })
    expect(view.door).toEqual(view.number.door)
    expect(view.promise).toMatchObject({ face: 'customer', of: 'promise', day: EN.day(row.promiseDate!), was: EN.day(row.originalPromiseDate!), door: view.door })
    expect(view.ordered.door).toEqual(view.door)
    expect('bar' in view.shipped && view.shipped.bar).toMatchObject({ shipped: row.pieces.shipped, units: row.pieces.ordered, door: { href: `${PREFIX}/orders/${row.id}?tab=shipments`, tip: { key: 'row.shipments' } } })
    expect(view.messages).toEqual({ href: `${PREFIX}/orders/${row.id}?tab=messages`, record: row.yourNumber!.words.en })
    expect(view.value?.door).toEqual(view.door)
    expect(view.mark).toBeNull()
  })

  it('the row\'s ONE mark "Needs your answer" on an order that waits for the customer\'s re-confirm (Z16 P3); never on a request', () => {
    const asked = BETA_ROWS.find((row) => row.needsYou)!
    expect(viewOf(order(asked)).mark).toMatchObject({ tone: 'warning', head: 'Needs your answer' })
    const request = viewOf({ kind: 'request', id: REQUESTS[0]!.id, request: REQUESTS[0]! })
    expect(REQUESTS[0]!.state.needsYou).toBe(true)
    expect(request.mark).toBeNull() // its own chip already says "We need something from you"
  })

  it('a request: "Your request 7" over its subject, its page the door of every cell, no picture; a closed one outlined', () => {
    const open = REQUESTS[0]!
    const view = viewOf({ kind: 'request', id: open.id, request: open })
    expect(view).toMatchObject({ kind: 'request', picture: false, href: `${PREFIX}/orders/requests/${open.id}` })
    expect(view.number).toMatchObject({ text: open.yourNumber!.words.en, sub: open.subject, door: { tip: { key: 'row.openRequest' } } })
    expect(view.state.mark).toBe(CUSTOMER_GROUP_ICON.REQUESTS)
    expect(view.promise).toMatchObject({ of: 'wanted' })
    expect('asked' in view.shipped).toBe(true)
    const closed = REQUESTS.find((row) => row.state.code === 'DECLINED')!
    expect(viewOf({ kind: 'request', id: closed.id, request: closed }).state).toMatchObject({ tone: 'neutral', mark: CUSTOMER_GROUP_ICON.CLOSED_REQUESTS, line: true })
  })

  it('Z7: a catalogue request has no page — its Number is your PO, else "Catalogue"; every cell plain, no picture, no bubble door', () => {
    const catalogue = BETA_ROWS.find((row) => row.kind === 'REQUEST')!
    const view = viewOf(order(catalogue))
    expect(view).toMatchObject({ kind: 'catalogue', href: null, door: null, picture: false, mark: null, value: null, messages: { href: null } })
    expect(view.number).toEqual({ text: `Your PO ${catalogue.customerRef}`, sub: 'Catalogue', door: null })
    expect(view.promise.door).toBeNull()
    expect(view.ordered.door).toBeNull()
    expect(viewOf(order({ ...catalogue, customerRef: null })).number).toEqual({ text: 'Catalogue', sub: null, door: null })
  })

  it('no price without the grain: no Net value at all (and none on a request)', () => {
    expect(viewOf(order(), false).value).toBeNull()
    expect(viewOf({ kind: 'request', id: REQUESTS[0]!.id, request: REQUESTS[0]! }).value).toBeNull()
  })

  it('Promised: the customer\'s own day asked while nothing is promised; "No promise" when there is none', () => {
    const asked = viewOf(order({ ...BETA_ROWS[1]!, promiseDate: null, originalPromiseDate: null, promiseMoved: false, requestedDate: '2026-12-01' })).promise
    expect(asked).toMatchObject({ of: 'asked', day: EN.day('2026-12-01') })
    expect(viewOf(order({ ...BETA_ROWS[1]!, promiseDate: null, requestedDate: null })).promise).toMatchObject({ day: null })
  })
})

describe('pg-t: D6 — a parcel is named by its order, never the office\'s series', () => {
  it('the next parcel in words: "Next parcel: Your order 21 · parcel 2 · expected …"; nothing without its order\'s own number, its place or a day', () => {
    const row = BETA_ROWS[0]!
    const tip = nextParcelOf(row, EN)
    expect(tip).toBe(`Next parcel: Your order ${row.yourNumber!.seq} · parcel 2 · expected ${EN.day(row.nextShipment!.expectedDeliveryAt!.slice(0, 10))}`)
    expect(nextParcelOf({ ...row, nextShipment: { ...row.nextShipment!, parcel: undefined } }, EN)).toBeNull() // an older answer
    expect(nextParcelOf({ ...row, yourNumber: null }, EN)).toBeNull()
    expect(nextParcelOf({ ...row, nextShipment: null }, EN)).toBeNull()
    const it_ = wordsFor('it')
    expect(nextParcelOf(row, it_)).toMatch(new RegExp(`^Prossimo collo: Vostro ordine ${row.yourNumber!.seq} · collo 2 · previsto il `))
    expect('bar' in viewOf(order(row)).shipped && (viewOf(order(row)).shipped as { bar: { tip: string | null } }).bar.tip).toBe(tip)
  })
  it('no row of the design reads carries an office series (orders, requests, parcels)', () => {
    expect(JSON.stringify([...ROWS, ...BETA_ROWS]).match(OFFICE_SERIES)?.[0] ?? null).toBeNull()
    for (const row of [...ROWS, ...BETA_ROWS]) {
      expect(row.number, row.id).toBeNull()
      expect(row.nextShipment?.number ?? null, row.id).toBeNull()
    }
  })
})

describe('pg-t: the groups and the address', () => {
  it('the address names a group (?chip=<GROUP>); anything else is everything open', () => {
    expect(groupOfAddress('SHIPPED')).toBe('SHIPPED')
    for (const old of ['OPEN', 'ALL', 'DATE_MOVED', 'NEEDS_YOU', null, undefined, 'nope']) expect(groupOfAddress(old)).toBeNull()
    expect(groupQuery(null, '')).toBe('')
    expect(groupQuery('REQUESTS', ' gloves ')).toBe('?chip=REQUESTS&q=gloves')
  })
  it('each group reads the server\'s own chip; Closed requests holds no order', () => {
    expect(CUSTOMER_GROUPS.map((group) => sheetChipOf(group))).toEqual(['REQUESTED', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'OPEN'])
    expect(sheetChipOf(null)).toBe('OPEN')
    expect(holdsOrders('CLOSED_REQUESTS')).toBe(false)
    expect(CUSTOMER_GROUPS.filter((group) => group !== 'CLOSED_REQUESTS').every(holdsOrders)).toBe(true)
  })
  it('H4: the open requests except those whose order waits (their order row carries them: once); the ended ones under Closed requests', () => {
    const open = requestsOf(null, REQUESTS)
    expect(open.some((row) => row.state.code === 'ORDER_WAITING')).toBe(false)
    expect(open.every((row) => row.state.open)).toBe(true)
    expect(requestsOf('REQUESTS', REQUESTS)).toEqual(open)
    expect(requestsOf('CLOSED_REQUESTS', REQUESTS).map((row) => row.state.code)).toEqual(['DECLINED'])
    expect(requestsOf('CLOSED_REQUESTS', [requestRow(1, 'CLOSED'), requestRow(2, 'WITHDRAWN'), requestRow(3, 'ORDER_CONFIRMED')]).map((row) => row.state.code)).toEqual(['CLOSED', 'WITHDRAWN'])
    expect(requestsOf('SHIPPED', REQUESTS)).toEqual([])
    // Requests first (the one that needs the customer on top), then the orders read; a search narrows the requests.
    const rows = listRowsOf(null, '', REQUESTS, BETA_ROWS, 'en')
    expect(rows[0]).toMatchObject({ kind: 'request', request: { state: { code: 'NEED_INFO' } } })
    expect(rows.filter((row) => row.kind === 'order')).toHaveLength(BETA_ROWS.length)
    expect(listRowsOf('CLOSED_REQUESTS', '', REQUESTS, BETA_ROWS, 'en').every((row) => row.kind === 'request')).toBe(true)
    expect(listRowsOf(null, 'gloves', REQUESTS, [], 'en').map((row) => row.id)).toEqual([REQUESTS[1]!.id])
  })
  it('the toolbar\'s count: the orders the read counts for the group and its requests shown (none of the orders under Closed requests)', () => {
    expect(countOf(null, null, 3)).toBeNull()
    expect(countOf({ count: 12 }, null, 3)).toBe(15)
    expect(countOf({ count: 12 }, 'CLOSED_REQUESTS', 2)).toBe(2) // G1-B1: never the Open orders' count
  })
})

describe('pg-t: the band\'s numbers are the server\'s (Z3)', () => {
  const read = (over: Partial<OrdersRead> = {}): OrdersRead => ({ ...betaOrdersRead('OPEN'), groups: CUSTOMER_GROUPS.map((group, index) => ({ group, count: index + 3 })), open: 40, needsYou: 4, ...over })
  it('each group\'s count exactly as the answer says it — never a count of the rows read (the search, the page of 50 change nothing)', () => {
    const band = bandOf(read(), 'ready', null)
    expect(band.groups.map((entry) => entry.count)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    expect(band.groups.every((entry) => entry.door)).toBe(true)
    expect([band.total, band.needsYou, band.state]).toEqual([40, 4, 'ready'])
    // A search that found one row: the band says what the server counted before the search.
    expect(bandOf(read({ items: [BETA_ROWS[0]!], count: 1 }), 'ready', 'SHIPPED').groups.map((entry) => entry.count)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
    // A group the page does not know is left out; one the answer does not name is "—".
    expect(bandOf(read({ groups: [{ group: 'SOMETHING_NEW', count: 99 }, { group: 'REQUESTS', count: 2 }] }), 'ready', null).groups.map((entry) => entry.count)).toEqual([2, null, null, null, null, null, null, null])
  })
  it('"—" while read; an older answer without groups: "—" and no group is a door (nothing says what it holds); failed: said once', () => {
    const reading = bandOf(null, 'loading', null)
    expect(reading.state).toBe('reading')
    expect(reading.groups.every((entry) => entry.count === null && !entry.door)).toBe(true)
    expect([reading.total, reading.needsYou]).toEqual([null, null])
    const older = bandOf(betaOrdersRead('OPEN'), 'ready', null)
    expect(older.groups.every((entry) => entry.count === null && !entry.door)).toBe(true)
    expect(older.state).toBe('ready')
    expect(bandOf(null, 'error', null).state).toBe('failed')
  })
  it('on screen: every number of the band is a number the read gave (the tiles, the fold, the notes, the closed groups)', () => {
    const screen = listScreen as unknown as DesignScreen<unknown>
    const entry = screen.cases.find((item) => item.id === 'th-223-list')!
    const built = (entry.model as (locale: 'en') => { body: { model: { read: OrdersRead } } })('en')
    const given = built.body.model.read
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(screen.view, { model: entry.model })))
    const drawn = [...html.matchAll(/class="fw-cwb-num">([^<]*)</g)].map((match) => match[1])
    expect(drawn.slice(0, 6)).toEqual(given.groups!.slice(0, 6).map((entry) => String(entry.count)))
    const allowed = new Set([...given.groups!.map((entry) => String(entry.count)), String(given.open)])
    expect(drawn.filter((value) => !allowed.has(value!))).toEqual([])
    expect(html).toContain(`<b class="fw-cwb-num">${given.open}</b>`)
    const loading = screen.cases.find((item) => item.id === 'loading')!
    const reading = renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(screen.view, { model: loading.model })))
    expect(reading).toContain('<b class="fw-cwb-num">—</b>')
    expect(reading).not.toContain('nds-metrics')
  })
  it('W05 / W10: two customers, each its own band — customer A moving never moves B\'s numbers (each read its own answer)', async () => {
    type Sheet = OrdersRead
    const world: Record<'alpha' | 'beta', Sheet> = { alpha: read({ items: ROWS.slice(0, 2), open: 7 }), beta: read() }
    const apiOf = (key: 'alpha' | 'beta') => ({ get: async (path: string, options: { schema: { parse: (value: unknown) => unknown } }) => (path === '/portal/sales-orders/sheet' ? options.schema.parse(world[key]) : Promise.reject(new Error(`unexpected GET ${path}`))) }) as unknown as ApiClient
    const bandFor = async (key: 'alpha' | 'beta') => bandOf(await fetchSheet(apiOf(key), { chip: 'OPEN' }), 'ready', null)
    const beta = await bandFor('beta')
    const alpha = await bandFor('alpha')
    world.alpha = { ...world.alpha, groups: world.alpha.groups!.map((entry) => ({ ...entry, count: entry.count + 10 })), open: 99, needsYou: 9 }
    expect(await bandFor('beta')).toEqual(beta)
    expect(await bandFor('alpha')).not.toEqual(alpha)
    expect((await bandFor('alpha')).total).toBe(99)
  })
})

describe('pg-t: D8, Z16 P1 — the columns the room holds (no sideways scroll, no dead space)', () => {
  const input = { seesPrices: true, messages: true, portal: 5 }
  it('1440 (a 1138 px grid): the fixed cells + 2 of your columns = 1136 px; 1920 (1618 px): Ordered and up to 5', () => {
    const fixed = LIST_WIDTHS.picture + LIST_WIDTHS.number + LIST_WIDTHS.whereItIs + LIST_WIDTHS.promised + LIST_WIDTHS.shipped + LIST_WIDTHS.newMessages + LIST_WIDTHS.value
    expect(fixed + 2 * LIST_WIDTHS.portal).toBe(1136)
    expect(roomColumnsOf(1138, input)).toEqual({ ordered: false, portal: 2 })
    expect(roomColumnsOf(1618, input)).toEqual({ ordered: true, portal: 5 })
    expect(roomColumnsOf(1599, input).ordered).toBe(false)
    expect(roomColumnsOf(0, input)).toEqual({ ordered: false, portal: 0 }) // not measured yet: the fixed cells only
    // Without prices and without the bubble's column the room holds more of them; never more than the office ticked.
    expect(roomColumnsOf(1138, { seesPrices: false, messages: false, portal: 5 }).portal).toBe(3)
    expect(roomColumnsOf(4000, { seesPrices: true, messages: true, portal: 1 }).portal).toBe(1)
  })
  it('the grid: no Kind, Subject, Date, ⋯, Next shipment and no selection column; the room is the list\'s own, never the window', () => {
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    const ids = [...view.matchAll(/column\('([a-zA-Z]+)'/g)].map((match) => match[1])
    expect(ids).toEqual(['picture', 'number', 'whereItIs', 'promised', 'ordered', 'shipped', 'newMessages', 'value'])
    expect(view).not.toMatch(/selection=\{|colId: 'actions'|'kind'|'subject'|'nextShipment'|matchMedia|innerWidth/)
    expect(view).toContain('const room = useRoomWidth(roomOf, 0)')
    expect(view).toContain('...portal.slice(0, fit.portal)')
  })
})

describe('pg-t: D4 — the customer\'s own pictures', () => {
  it('the list reads the walled portal route (own orders only); the answer names no file: its small address is kept under its order', () => {
    expect(PICTURE_ROUTES.customerOrder).toEqual({ path: '/portal/sales-orders/pictures', key: 'orderIds' })
    const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(view.match(/source="customerOrder"/g)?.length).toBe(2) // the grid's cell and the phone card
    expect(view).not.toMatch(/source="(?:order|portalOrder)"/) // never an office picture route
    const api = readFileSync(new URL('../../../lib/record-picture/api.ts', import.meta.url), 'utf8')
    expect(api).toContain("source === 'customerOrder' && picture.fileId === null && picture.small ? { ...picture, fileId: `${source}:${picture.id}` } : picture")
    const page = readFileSync(new URL('./OrdersPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain('const pictures = useMemo(() => pictureReader(api), [api])')
  })
})

describe('pg-t: the words, EN + IT, "voi", no raw key', () => {
  it('the host\'s new words and the shared parts\' customer words in both languages; Italian says "voi"', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, CATALOGUE[locale][NS] ?? {})
      for (const key of ['list.yourPo', 'list.emptyBodyView', 'list.clearSearch', 'col.picture', 'col.whereItIs', 'col.promised', 'col.orderedOn', 'band.downloadAll', 'band.downloadAllHint', 'list.searchHint', 'list.clear', 'row.open', 'row.shipments', 'row.openRequest']) expect(t(key, { ref: 'X' }), `${locale} ${key}`).not.toBe(key)
      const w = createTranslator(locale, CATALOGUE[locale]['order-list'] ?? {})
      for (const key of ['group.REQUESTS', 'group.CLOSED_REQUESTS', 'band.label', 'band.groups', 'band.open', 'band.openCount', 'band.groupTip', 'band.groupOnTip', 'band.sum', 'mark.needsYou', 'promise.was', 'promise.asked', 'promise.wanted', 'shipped.asked', 'shipped.tip', 'shipped.parcel']) expect(w(`customer.${key}`, { group: 'X', date: 'd', count: 2, name: 'n', order: 1, n: 1 }), `${locale} ${key}`).not.toBe(`customer.${key}`)
    }
    const it_ = createTranslator('it', CATALOGUE.it[NS] ?? {})
    expect([it_('list.emptyBodyView'), it_('band.downloadAll'), it_('list.clear')]).toEqual(['I vostri ordini appaiono qui appena li facciamo.', 'Scarica (Excel)', 'Mostra tutto ciò che è aperto'])
    const en = createTranslator('en', CATALOGUE.en[NS] ?? {})
    expect([en('list.searchHint'), en('band.downloadAll')]).toEqual(['Your PO, order number, style or request…', 'Download (Excel)'])
    // G1-B8: the shared message cell says "conversation" to the portal, neutral words in its hint (every portal list reads them).
    for (const locale of LOCALES) {
      const outside = CATALOGUE[locale]['outside-words'] ?? {}
      expect(outside['last-message.columnHint'], locale).toMatch(/convers/)
      expect(outside['last-message.columnHint'], locale).not.toMatch(/\b(order|ordine|record|thread)\b/i)
    }
  })
})

describe('pg-t: Brand Beta\'s cases hold nothing of Brand Alpha and no office series', () => {
  const screen = listScreen as unknown as DesignScreen<unknown>
  const render = (locale: 'it' | 'en', id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))
  it('every th- case, both languages: no Alpha name, id or PO; no office series; no "€" without the grain', () => {
    const beta = screen.cases.filter((item) => /^th-(?:223|230|246)-/.test(item.id))
    expect(beta.length).toBeGreaterThanOrEqual(19)
    const alphaCodes = ROWS.flatMap((row) => [row.id, row.customerRef]).filter((code): code is string => !!code)
    for (const entry of beta) {
      for (const locale of ['it', 'en'] as const) {
        const html = render(locale, entry.id)
        expect(scanText(html, BRAND_ALPHA), `${entry.id} (${locale})`).toEqual([])
        expect(html.match(OFFICE_SERIES)?.[0] ?? null, `${entry.id} (${locale})`).toBeNull()
        const data = JSON.stringify((entry.model as (locale: 'it' | 'en') => { body: unknown })(locale).body)
        expect(alphaCodes.filter((code) => data.includes(code)), `${entry.id} (${locale})`).toEqual([])
      }
    }
    expect(render('en', 'th-223-no-prices')).not.toContain('€')
  })
  it('the band and its words draw; the empty list never names New order to who may not order (G1-B11)', () => {
    const list = render('en', 'th-223-list')
    for (const words of ['Your orders by where they are', 'Requests', 'Confirmed', 'In production', 'Closed requests', 'Your open orders and requests:']) expect(list).toContain(words)
    expect(render('it', 'th-223-list')).toContain('I vostri ordini e richieste aperti:')
    expect(render('en', 'th-223-empty')).toContain('What you send with New order')
    const viewer = render('en', 'th-223-empty-viewer')
    expect(viewer).toContain('Your orders show here as soon as we make them.')
    expect(viewer).not.toContain('What you send with New order')
    expect(render('en', 'th-223-search')).toContain('Clear the search')
    expect(render('en', 'chip-empty')).toContain('Show everything open')
  })
  it('a request\'s rows of the made-up reads: one Brand Alpha request never shows among Brand Beta\'s', () => {
    const alien = { ...requestRow(9, 'SENT'), id: BRAND_ALPHA.ids.order, customerRef: BRAND_ALPHA.customerRef }
    expect(requestsOf(null, REQUESTS).some((row) => row.id === alien.id)).toBe(false)
  })
})

describe('pg-fx3: the end walk\'s fixes (40-walk.md)', () => {
  const screen = listScreen as unknown as DesignScreen<unknown>
  const render = (id: string) => renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell', 'portal']) }, createElement(screen.view, { model: screen.cases.find((item) => item.id === id)!.model })))
  const view = readFileSync(new URL('./view/OrdersListView.tsx', import.meta.url), 'utf8')
  it('W-03: no connection is said once — by the shell; the list draws no banner of its own (its rows stay, Show more is held)', () => {
    expect(view).not.toContain("t('offline.title'")
    expect(render('offline')).not.toContain('No connection — showing what was loaded')
    expect(view).toContain("model.offlineSince ? t('held.offline') : null")
  })
  it('W-04: a ticked column\'s head wraps to two lines (never cut); its tip names the column, then the hint', () => {
    expect(view).toContain("wrapHeaderText: true, headerClass: 'fw-pgl-hwrap', headerTooltip: `${label} · ${t('sheet.columnHint')}`")
    const css = readFileSync(new URL('./list.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.fw-pgl \.ag-header-cell\.fw-pgl-hwrap \.ag-header-cell-comp-wrapper,\s*\.fw-pgl \.ag-header-cell\.fw-pgl-hwrap \.ag-header-cell-text \{\s*white-space: normal;/)
  })
  it('W-07: the two empty states draw the picture\'s magnifier (nothing in a group, nothing found); the empty list its own mark', () => {
    expect(render('chip-empty')).toContain('lucide-search')
    expect(render('th-223-search')).toContain('lucide-search')
    expect(render('th-223-empty')).toContain('lucide-package-search')
  })
  it('W-06: a failed read — the band says only "Couldn\'t be read · Try again" (no notes line, no ⓘ); the grid slot says why', () => {
    const html = render('error')
    expect(html).toContain('class="fw-cb-failed" role="status"')
    expect(html).not.toContain('Your open orders and requests')
    expect(html).not.toContain('About these numbers')
    expect(html).toContain('Your orders and requests could not be read')
  })
})

describe('pg-t: Download (Excel) is the one export, of the group shown', () => {
  it('the page asks the server\'s file with the group\'s own chip and the search; none under Closed requests', () => {
    const page = readFileSync(new URL('./OrdersPage.tsx', import.meta.url), 'utf8')
    expect(page).toContain("downloadSheet(api, { chip: sheetChipOf(group), q, format: 'XLSX'")
    expect(page).toContain('...(orders ? { onDownloadAll: () => void downloadAll() } : {})')
    expect(page).not.toMatch(/listCsv|saveText|print=1|OrdersPrintView|fetchInTransit/)
    expect(ordersRead('OPEN').items.length).toBeGreaterThan(0)
  })
})
