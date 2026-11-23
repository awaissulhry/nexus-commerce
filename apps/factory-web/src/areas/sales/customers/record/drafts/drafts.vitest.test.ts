import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import type { ApiClient } from '../../../../../lib/api/client'
import { LOCALES } from '../../../../../lib/i18n/locales'
import { createTranslator, messagesFor } from '../../../../../lib/i18n/messages'
import { render, textOf } from '../../../../../lib/record-thread/parts/testing'
import type { OrdersListModel } from '../../../orders/list/list-model'
import { catalogueHeld } from '../../../inquiries/catalogue-model'
import { lockedEntry } from '../../../orders/list/use-orders-sheet'
import { workEntry } from '../use-customer-work'
import { DRAFTS_VIEW, workViewsOf } from '../view/WorkTab'
import { listCustomerDrafts, type DraftRow } from './api'
import { draftPick, draftsAddress, draftsNav, draftsShown, draftsTouched, draftTitle, filesWords, linesWords, messagesWords, readyOf, showsValue } from './model'
import { draftValueOf } from './model' // F-CP-141
import { CustomerDraftsList, type CustomerDraftsListModel } from './view/CustomerDraftsList'

/**
 * F-CP-107 (customer page plan D10; 10-customer-page §6; 12-portal-drafts-team §3; review G3, G4) — "Drafts of <customer>" on the
 * Work tab: the customer's portal drafts, read only, through B-CP-071's walled list. Each row in words, the decisions held while it is
 * the customer's draft, `list=drafts` written once (alone and beside a view term), the states, live changes coalesced, the dock pick,
 * the window's walk, and the money wall (no Value column "as Sales worker / as Production manager").
 */

const ALPHA = '11111111-1111-4111-8111-111111111111'
const BASE = `/w/acme/sales/customers/${ALPHA}`
const params = (query: string) => new URLSearchParams(query)
const search = (address: string) => address.slice(address.indexOf('?') + 1)
const t = createTranslator('en', messagesFor('en', ['parties']).parties!)

const row = (over: Partial<DraftRow> = {}, draft: Partial<NonNullable<DraftRow['draft']>> = {}): DraftRow => ({
  id: 'd0000000-0000-4000-8000-000000000001',
  number: null,
  status: 'DRAFT',
  party: { id: ALPHA, code: 'ALPHA', name: 'Brand Alpha' },
  customerRef: null,
  requestedDate: '2026-12-15',
  lines: 3,
  pieces: 140,
  currency: 'EUR',
  version: 4,
  draft: {
    startedBy: 'Giulia Verdi',
    startedAt: '2026-11-12T09:00:00.000Z',
    lastEditedBy: 'Giulia Verdi',
    lastEditedAt: '2026-11-19T10:42:00.000Z',
    title: 'STY-01 Giacca demo',
    people: 12,
    readiness: { parts: [], done: 5, of: 6, problems: 1 },
    later: ['PEOPLE'],
    thread: { messages: 4, lastAt: '2026-11-19T10:40:00.000Z', designerAsked: true },
    files: { logos: [file('l1'), file('l2')], references: [], sheets: [file('s1', true)] },
    ...draft,
  },
  ...over,
})
function file(id: string, locked = false) {
  return { id, lineId: null, originalName: locked ? null : `${id}.pdf`, kind: 'ATTACHMENT', sizeBytes: 1000, status: 'READY', locked }
}
const say = (words: { key: string; params?: Readonly<Record<string, string | number>> }) => t(words.key, words.params)

describe('a draft row in words', () => {
  it('its title (else "Untitled draft"), its counts, its files (counts only), how ready it is, its conversation', () => {
    expect(draftTitle(row(), 'Untitled draft')).toBe('STY-01 Giacca demo')
    expect(draftTitle(row({}, { title: null }), 'Untitled draft')).toBe('Untitled draft')
    expect(linesWords(row()).map(say)).toEqual(['3 lines', '140 pieces', '12 people'])
    expect(linesWords(row({ lines: 1, pieces: 1 }, { people: 0 })).map(say)).toEqual(['1 line', '1 piece'])
    expect(filesWords(row()).map(say)).toEqual(['2 logos', '1 measurement sheet'])
    // A locked measurement sheet is counted, never named.
    expect(JSON.stringify(filesWords(row()))).not.toContain('s1.pdf')
    expect(readyOf(row())).toEqual({ words: { key: 'customers.drafts.ready', params: { done: 5, of: 6 } }, problems: 1 })
    expect(say(readyOf(row())!.words)).toBe('5 of 6')
    expect(say(messagesWords(row())!)).toBe('4 messages · asked the factory designer')
    expect(messagesWords(row({}, { thread: null }))).toBeNull()
  })

  it('the dock pick is the draft\'s own conversation; the window walks the list in its order', () => {
    expect(draftPick(row(), 'STY-01 Giacca demo')).toEqual({ type: 'PortalOrderRequest', id: row().id, label: 'STY-01 Giacca demo', companyId: null })
    expect(draftsNav([{ id: 'a' }, { id: 'b' }], 'b')).toEqual({ ids: ['a', 'b'], current: 'b' })
  })
})

describe('the view and its address (fx-12, review G4)', () => {
  it('Drafts of <customer> is offered on the Work tab, after Late; list=drafts is the view', () => {
    expect(workViewsOf({ price: false }, { drafts: true })).toContain(DRAFTS_VIEW)
    expect(draftsShown(params('tab=work&list=drafts'))).toBe(true)
    expect(draftsShown(params('tab=work'))).toBe(false)
  })

  it('the address is written once: the entry and the lock write nothing more; alone and beside the dock', () => {
    for (const now of ['tab=work&party=x&rows=all', `tab=work&party=${ALPHA}&status=IN_PRODUCTION&dock=SalesOrder.33333333-3333-4333-8333-333333333333`]) {
      const address = draftsAddress(BASE, ALPHA, params(now))
      const written = params(search(address))
      expect(written.get('list')).toBe('drafts')
      expect(written.get('party')).toBe(ALPHA)
      expect(written.has('rows') || written.has('status')).toBe(false)
      expect(workEntry(BASE, ALPHA, params(search(address)))).toBeNull()
      expect(lockedEntry(BASE, { locked: { party: ALPHA } }, params(search(address)))).toBeNull()
      expect(draftsAddress(BASE, ALPHA, params(search(address)))).toBe(address)
    }
    expect(params(search(draftsAddress(BASE, ALPHA, params('dock=all')))).get('dock')).toBe('all')
  })

  // F-CW-102 (lead settle S28): the Drafts view beside the dock at 1440 scrolled sideways (1058 px of columns in 863: Ready and
  // Wanted by took the grid's 200 px default). Every column of the narrow table now has its least width and its share of the room.
  it('F-CW-102: the columns fit the 863 px beside the dock (no sideways scroll): each has its least width and its share', () => {
    const view = readFileSync(new URL('./view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    const narrow = ['draft', 'lines', 'files', 'ready', 'changed', 'wanted', 'more']
    const widths = narrow.map((id) => {
      const column = view.slice(view.indexOf(`colId: '${id}'`))
      const min = column.match(/minWidth: (\d+)/)
      expect(min, id).not.toBeNull()
      return Number(min![1])
    })
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(863)
    for (const id of ['draft', 'lines', 'files', 'ready', 'changed', 'wanted']) expect(view.slice(view.indexOf(`colId: '${id}'`)).split('colId:')[1], id).toMatch(/flex: /)
  })

  // F-CW-104 (10-design §3.8; S28: the sideways scroll only): Messages and the value come with the Work tab's `wide` room (1150 px of
  // sheet), each with its share — before, the window decided (1800 px: 1250 px of columns in the 1183 px beside the thread at 1920).
  it('F-CW-104: the wide columns come with the tab\'s room and fit it (no sideways scroll at 1183)', () => {
    const view = readFileSync(new URL('./view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    const all = ['draft', 'lines', 'files', 'ready', 'changed', 'wanted', 'messages', 'value', 'more']
    const widths = all.map((id) => Number(view.slice(view.indexOf(`colId: '${id}'`)).match(/minWidth: (\d+)/)![1]))
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeLessThanOrEqual(1150)
    for (const id of ['messages', 'value']) expect(view.slice(view.indexOf(`colId: '${id}'`)).split('colId:')[1], id).toMatch(/flex: /)
    // The host's word is followed live (the thread closed or opened); without one the window decides as before.
    expect(view).toContain('return forced ?? wide')
    const tab = readFileSync(new URL('../view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain("wide: workRoom.room !== 'base'")
  })

  it('the pick writes through the record pages\' one history writer; a rows view picked again goes through the sheet (which drops `list`)', () => {
    const tab = readFileSync(new URL('../view/WorkTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('if (id === DRAFTS_VIEW) writeSearch(draftsAddress(`${prefix}${basePath}`, party.id, params))')
    expect(tab.match(/router\.replace\(/g)?.length).toBe(1)
  })
})

describe('read only: the decisions wait until the customer sends it', () => {
  it('Accept as order, Accept as quote and Refuse are held with why on a draft (the pane draws them held, not hidden)', () => {
    const record = { request: { status: 'DRAFT' }, may: { order: false, quote: false, refuse: false } } as never
    for (const action of ['order', 'quote', 'refuse'] as const) expect(catalogueHeld(record, action, { orders: true, quotes: true }, false)).toEqual({ key: 'catalogue.held.DRAFT' })
    const pane = readFileSync(new URL('../../../inquiries/view/pane/catalogue/CataloguePane.tsx', import.meta.url), 'utf8')
    expect(pane).toContain("main || (model.draft && request.status === 'DRAFT')")
    const container = readFileSync(new URL('../../../inquiries/use-catalogue-order.tsx', import.meta.url), 'utf8')
    expect(container).toContain('!told.current.draft')
    const window = readFileSync(new URL('./view/DraftWindow.tsx', import.meta.url), 'utf8')
    expect(window).toContain("t('customers.drafts.readOnly', { customer: model.customer })")
    expect(window).toContain('nav={{ ids: model.nav.ids, current: model.nav.current')
    for (const locale of LOCALES) {
      const inquiries = createTranslator(locale, messagesFor(locale, ['sales-inquiries'])['sales-inquiries']!)
      expect(inquiries('catalogue.held.DRAFT'), locale).not.toBe('catalogue.held.DRAFT')
    }
  })
})

describe('the read, live changes and the states', () => {
  it('ONE walled read per customer: GET /sales/order-requests?status=DRAFT&partyId (the brand wall is the API\'s: another customer answers 404)', async () => {
    const calls: Array<{ path: string; query: unknown }> = []
    const api = { get: async (path: string, options: { query?: unknown; schema: { parse: (value: unknown) => unknown } }) => (calls.push({ path, query: options.query }), options.schema.parse({ requests: [row()] })) } as unknown as ApiClient
    const rows = await listCustomerDrafts(api, ALPHA)
    expect(calls).toEqual([{ path: '/sales/order-requests', query: { status: 'DRAFT', partyId: ALPHA } }])
    expect(rows[0]!.draft?.title).toBe('STY-01 Giacca demo')
  })

  it('live: a draft changed or sent is counted behind "N updates · Show", coalesced (800 ms); the rows are read again on Show', () => {
    expect(draftsTouched('portal_order_request.draft_changed')).toBe(true)
    expect(draftsTouched('portal_order_request.sent')).toBe(true)
    expect(draftsTouched('sales_order.created')).toBe(false)
    const hook = readFileSync(new URL('./use-customer-drafts.ts', import.meta.url), 'utf8')
    expect(hook).toContain('}, 800)')
    expect(hook).toContain('onShowUpdates: load')
  })

  const views = { model: { rows: 'open', kind: null, waiting: null, customer: { id: ALPHA, name: 'Brand Alpha' }, locked: { party: true, kind: false }, views: workViewsOf({ price: true }, { drafts: true }), hostViews: [{ id: DRAFTS_VIEW, label: 'Drafts of Brand Alpha', active: true }] } as unknown as OrdersListModel }
  const model = (over: Partial<CustomerDraftsListModel> = {}): CustomerDraftsListModel => ({ customer: 'Brand Alpha', read: { status: 'ready', rows: [row()] }, updates: 0, activeId: null, views, wide: true, ...over })

  it('the states in words: none, failed (Try again); no key left on screen, in both languages', () => {
    for (const locale of LOCALES) {
      const none = render(createElement(CustomerDraftsList, { model: model({ read: { status: 'ready', rows: [] } }) }), locale)
      expect(textOf(none)).toContain(locale === 'en' ? 'Brand Alpha has no draft in the portal.' : 'Brand Alpha non ha bozze nel portale.')
      const failed = render(createElement(CustomerDraftsList, { model: model({ read: { status: 'failed' } }) }), locale)
      expect(textOf(failed)).toContain(locale === 'en' ? "Couldn't read the drafts" : 'Non riesco a leggere le bozze')
      expect(textOf(failed)).not.toMatch(/customers\.drafts\./)
    }
  })

  it('money wall: no Value column "as Sales worker / as Production manager" (the API drops netShown); a price holder sees it', () => {
    expect(showsValue([row()])).toBe(false)
    expect(showsValue(null)).toBe(false)
    expect(showsValue([row({ netShown: '1840.00' })])).toBe(true)
    expect(showsValue([row({ netShown: null })])).toBe(true)
    const view = readFileSync(new URL('./view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    expect(view).toContain("...(price\n        ? [")
    expect(view).toContain('const price = showsValue(rows)')
  })

  it('read only: no selection, no export (no list key); Enter and Open show the window, a click the dock', () => {
    const view = readFileSync(new URL('./view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    expect(view).toContain('listKey={null}')
    expect(view).not.toContain('selection=')
    expect(view).toContain('onOpen={(row) => actions?.onOpen?.(row)}')
    expect(view).toContain('onRowClick={(row) => actions?.onRow?.(row)}')
  })

  it('the words in both languages', () => {
    for (const locale of LOCALES) {
      const words = createTranslator(locale, messagesFor(locale, ['parties']).parties!)
      for (const key of ['customers.drafts.col.draft', 'customers.drafts.col.value', 'customers.drafts.untitled', 'customers.drafts.open', 'customers.drafts.noun']) expect(words(key), `${locale} ${key}`).not.toBe(key)
      expect(words('customers.work.view.drafts', { customer: 'Brand Alpha' }), locale).toContain('Brand Alpha')
      expect(words('customers.drafts.readOnly', { customer: 'Brand Alpha' }), locale).toContain('Brand Alpha')
    }
  })
})

// ---- F-CP-141 (follow-up 6; the API's B-CP-076): the Value column reads the draft's own value when the API sends it -----------------
describe('F-CP-141: the Drafts Value column — draft.draftValueAmount, else the net at the prices shown', () => {
  it('the draft value (minor units) wins; null says "not known"; without it the net shown; neither: no value', () => {
    expect(draftValueOf(row({ netShown: '1840.00' }, { draftValueAmount: 2_150_00 }))).toEqual({ minor: 2_150_00 })
    expect(draftValueOf(row({ netShown: '1840.00' }, { draftValueAmount: null }))).toBeNull()
    expect(draftValueOf(row({ netShown: '1840.00' }))).toEqual({ decimal: '1840.00' })
    expect(draftValueOf(row())).toBeNull()
  })
  it('the money wall: the column only when a row carries either field (as Sales worker / as Production manager neither comes)', () => {
    expect(showsValue([row({}, { draftValueAmount: 0 })])).toBe(true)
    expect(showsValue([row({}, { draftValueAmount: null })])).toBe(true)
    expect(showsValue([row()])).toBe(false)
    const view = readFileSync(new URL('./view/CustomerDraftsList.tsx', import.meta.url), 'utf8')
    expect(view).toContain("return 'minor' in value ? money(value.minor, params.data.currency, locale) : priceText(value.decimal, params.data.currency, INTL_LOCALE[locale])")
  })
})
// ---- end F-CP-141

// ---- cp-walk (customer page review walk, F-CP-107): the draft open in its window is this customer's own, and its ⋯ has a name ----
describe('cp-walk: the draft window', () => {
  it('the design\'s draft is the page customer\'s: its name, its address, the draft\'s own state words (never another customer\'s)', async () => {
    const { draftRequestOf } = await import('../fixtures')
    const party = { id: ALPHA, code: 'ALPHA', legalName: 'Brand Alpha S.r.l.', tradeName: 'Brand Alpha' } as never
    const request = draftRequestOf(party)
    expect(request.party).toEqual({ id: ALPHA, code: 'ALPHA', name: 'Brand Alpha' })
    expect([request.status, request.words.en, request.words.it, request.number]).toEqual(['DRAFT', 'Draft', 'Bozza', null])
    expect(request.shipTo?.name).toBe('Brand Alpha · warehouse')
    expect(JSON.stringify(request)).not.toContain('Rider Shop')
    // F-CP-113's lines window on the same page names the same customer (never the orders demo's own).
    const { linesWindowOf } = await import('../fixtures')
    const lines = linesWindowOf('lines', true, party)
    expect([lines.header?.partyId, lines.party.status === 'ready' ? lines.party.value.legalName : null]).toEqual([ALPHA, 'Brand Alpha S.r.l.'])
  })
  it('a draft has no number yet: its ⋯ is named by its title and offers no "Copy number"', async () => {
    const { CataloguePane } = await import('../../../inquiries/view/pane/catalogue/CataloguePane')
    const { CATALOGUE_RECORD } = await import('../../../inquiries/demo/fixtures')
    const { inquiriesCan } = await import('../../../inquiries/model')
    const request = { ...CATALOGUE_RECORD.request, status: 'DRAFT', number: null, sentAt: null, sentBy: null }
    const model = { prefix: '/w/DEMO', can: inquiriesCan(['orders.view', 'threads.read']), offline: false, loaded: { status: 'ready', value: { ...CATALOGUE_RECORD, request, may: { order: false, quote: false, refuse: false } } }, notice: null, dialog: null, handled: null, draft: { title: 'STY-01 Giacca demo' } }
    const html = render(createElement(CataloguePane, { model: model as never }))
    expect(html).toContain('aria-label="More for STY-01 Giacca demo"')
    expect(html).not.toContain('aria-label="More for "')
    const pane = readFileSync(new URL('../../../inquiries/view/pane/catalogue/CataloguePane.tsx', import.meta.url), 'utf8')
    expect(pane).toContain("...(number ? [{ id: 'copy', label: t('record.copyNumber')")
  })
})
// ---- end cp-walk
