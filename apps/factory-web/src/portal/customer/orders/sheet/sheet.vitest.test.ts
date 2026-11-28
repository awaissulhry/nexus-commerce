import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { everyCase, leftKeys, render, textOf } from '../../../../lib/record-thread/parts/testing'
import { fetchSheet, orderRowSchema, ordersSchema, type OrderRow } from '../api'
import { lineIdOfKey, PORTAL_SHEET_COLUMNS, PORTAL_SHEET_FILTERS, sheetOrderOf, sheetOrdersOf, sheetRowsOf, sheetRowsOfOrder } from './adapter'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { designScreen } from './fixtures'
import { bulkOf, detailsOf, draftsOf, lifeOf, listedRows, pageOf, pictureDoorOf, sentLineOf, waitChipsOf, withdrawnCount } from './model'
import { DraftsBar, PictureButton, WaitsChips, WithdrawnChip } from './view/SheetParts'

/**
 * owb-po7 — the customer's orders sheet: the adapter maps every row kind (ORDER / REQUEST / DRAFT) with NO price key and keeps the
 * office-ticked columns; Take it back on a sent row; bulk delete asks first; withdrawn rows behind their chip; the picture is a button a
 * keyboard reaches; every Waits · news chip is a door; the phone's camera always shows; the gallery cases draw in both languages.
 */

const MONEY = /price|amount|net|currency|cost|margin/i
function keysOf(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, out)
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      out.push(key)
      keysOf(inner, out)
    }
  return out
}

/** A row as the server's owb-po1 sends it (made-up data). */
function row(kind: 'ORDER' | 'REQUEST' | 'DRAFT', over: Record<string, unknown> = {}): OrderRow {
  return orderRowSchema.parse({
    kind,
    id: `${kind.toLowerCase()}-1`,
    customerRef: 'PO-EX-1',
    subject: kind === 'ORDER' ? null : 'Race suits 2027',
    number: null,
    yourNumber: kind === 'ORDER' ? { seq: 12, words: { it: 'Il vostro ordine 12', en: 'Your order 12' } } : null,
    orderedOn: null,
    status: kind === 'DRAFT' ? 'DRAFT' : 'CONFIRMED',
    words: { it: 'Confermato', en: 'Confirmed' },
    promiseDate: null,
    originalPromiseDate: null,
    promiseMoved: false,
    movedLately: false,
    requestedDate: '2027-02-01',
    pieces: { ordered: 6, shipped: 0, open: 6 },
    netAmount: 410,
    currency: 'EUR',
    nextShipment: null,
    progressPercent: null,
    values: { 'cf:box_type': { value: 'GIFT', wordsIt: null, wordsEn: null } },
    page: kind === 'ORDER' ? { kind: 'order', id: 'order-1' } : { kind: 'request', id: `${kind.toLowerCase()}-1` },
    life: kind === 'ORDER' ? 'CONFIRMED' : kind === 'REQUEST' ? 'SENT' : 'DRAFT',
    lines: [{ id: 'l-1', seq: 1, model: { kind: 'OWN', words: 'Alpha race suit', garmentType: null }, material: 'Cowhide black', sizes: '2 × 50', pieces: 6, ownValues: { 'c-remake': { columnId: 'c-remake', value: true, version: 1 } } }],
    ownColumnIds: ['c-remake'],
    waits: [{ kind: 'NEW_MESSAGES', count: 1 }, { kind: 'SOMETHING_NEW', count: 3 }],
    may: { edit: kind === 'DRAFT', send: kind === 'DRAFT', delete: kind === 'DRAFT', takeBack: kind === 'REQUEST', picture: true },
    ...over,
  })
}

describe('owb-po7.1: the adapter', () => {
  it('every row kind maps: a P row with its page and life word, a C row per line; the office-ticked columns are kept', () => {
    for (const kind of ['ORDER', 'REQUEST', 'DRAFT'] as const) {
      const rows = sheetRowsOfOrder(row(kind), 'en')
      expect(rows.map((entry) => entry.row)).toEqual(['P', 'C'])
      const parent = rows[0]!
      if (parent.row !== 'P') throw new Error('P first')
      expect(parent.kind).toBe(kind)
      expect(parent.page?.kind).toBe(kind === 'ORDER' ? 'order' : 'request')
      expect(parent.life).toBe(kind === 'ORDER' ? 'CONFIRMED' : kind === 'REQUEST' ? 'SENT' : 'DRAFT')
      expect(parent.values['cf:box_type']?.value).toBe('GIFT')
    }
    expect((sheetRowsOfOrder(row('ORDER'), 'it')[0] as { yourNumber: string }).yourNumber).toBe('Il vostro ordine 12')
  })

  it('the sheet asks for the drafts with the opt-in flag drafts=true (owb-po1)', async () => {
    const asked: unknown[] = []
    const api = { get: async (path: string, init: { query: unknown }) => { asked.push({ path, query: init.query }); return { asOf: 'x', seesPrices: false, chip: 'OPEN', chips: [], count: 0, items: [], live: { events: [] } } } } as unknown as Parameters<typeof fetchSheet>[0]
    await fetchSheet(api, { chip: 'OPEN', drafts: true })
    await fetchSheet(api, { chip: 'OPEN' })
    expect(asked).toEqual([
      { path: '/portal/sales-orders/sheet', query: { chip: 'OPEN', q: undefined, limit: 50, offset: 0, drafts: 'true' } },
      { path: '/portal/sales-orders/sheet', query: { chip: 'OPEN', q: undefined, limit: 50, offset: 0, drafts: undefined } },
    ])
  })

  it('no price key ever, even from a price holder’s read (the orders sheet has no price column for anybody)', () => {
    const read = ordersSchema.parse({ asOf: '2026-11-28T10:00:00Z', seesPrices: true, chip: 'ALL', chips: [], count: 3, items: [row('ORDER'), row('REQUEST'), row('DRAFT')], live: { events: [] } })
    expect(keysOf(read).some((key) => MONEY.test(key))).toBe(true)
    expect(keysOf(sheetRowsOf(read, 'en')).filter((key) => MONEY.test(key))).toEqual([])
  })

  it('a newer answer’s unknown wait kind is left out; a DRAFT row parses (owb-po1 sends `status: null`); the life note is read', () => {
    expect(row('DRAFT').waits).toEqual([{ kind: 'NEW_MESSAGES', count: 1 }])
    expect(row('DRAFT', { status: null, netAmount: null }).status).toBe('REQUESTED')
    expect(row('ORDER', { lifeNote: { kind: 'PARTLY_SHIPPED', shipped: 2, total: 6 } }).lifeNote).toEqual({ kind: 'PARTLY_SHIPPED', shipped: 2, total: 6 })
    expect(row('ORDER', { lifeNote: { kind: 'SOMETHING_ELSE' } }).lifeNote).toBeUndefined()
    expect(lifeOf({ kind: 'REQUEST', life: undefined })).toBe('SENT')
    expect(pageOf({ kind: 'REQUEST', id: 'r', page: undefined })).toBeNull()
  })
})

describe('owb-po7.2: drafts and Send', () => {
  it('Take it back on a Sent row (the factory has not confirmed); never on a confirmed order', () => {
    const sent = row('REQUEST')
    expect(sentLineOf([sent], [sent.id])?.takeBack).toEqual([sent.id])
    expect(sentLineOf([row('ORDER', { id: sent.id })], [sent.id])?.takeBack).toEqual([])
    expect(sentLineOf([sent], [])).toBeNull()
  })

  it('bulk delete asks first: nothing is asked or deleted on drawing; each draft has its bin, the bar Send… and Delete the drafts', () => {
    const html = render(createElement(DraftsBar, { model: { drafts: [{ id: 'd-1', title: 'Race suits 2027', href: '/p/X/orders/new?draft=d-1' }, { id: 'd-2', title: null, href: '/p/X/orders/new?draft=d-2' }], sendHeld: null, deleteHeld: null, busy: false } }))
    const text = textOf(html)
    expect(text).toContain('2 drafts of a new order')
    expect(text).toContain('Delete the drafts')
    expect(text).toContain('Send…')
    expect(text).not.toContain('The factory never saw') // the question comes only after the press
    expect(html).toContain('aria-label="Delete the draft “Race suits 2027”"')
    expect(html).toContain('aria-label="Delete the draft “No subject”"')
    // the delete command runs only from the question's own Delete button
    const parts = readFileSync(new URL('./view/SheetParts.tsx', import.meta.url), 'utf8')
    expect(parts.match(/actions\?\.onDelete\?\./g)).toHaveLength(1)
    expect(bulkOf([row('DRAFT'), row('ORDER')], ['draft-1', 'order-1']).remove.map((entry) => entry.id)).toEqual(['draft-1'])
  })

  it('withdrawn rows hide behind their chip; drafts are in the drafts bar, not the list', () => {
    const rows = [row('ORDER'), row('REQUEST', { id: 'gone-1', life: 'WITHDRAWN' }), row('DRAFT')]
    expect(listedRows(rows, false).map((entry) => entry.id)).toEqual(['order-1'])
    expect(listedRows(rows, true).map((entry) => entry.id)).toEqual(['order-1', 'gone-1'])
    expect(draftsOf(rows).map((entry) => entry.id)).toEqual(['draft-1'])
    expect(withdrawnCount(rows)).toBe(1)
    expect(textOf(render(createElement(WithdrawnChip, { count: 1, shown: false })))).toBe('Withdrawn 1')
  })
})

describe('owb-po7.3 + po7.4: picture, Waits · news, Details, phone', () => {
  it('the picture is a real button with words (keyboard reaches it); no picture door on a withdrawn row or without the right', () => {
    const html = render(createElement(PictureButton, { picture: createElement('span', null, 'pic'), label: 'The picture of the order: change it', onPress: () => undefined }))
    expect(html).toMatch(/^<button type="button" class="fw-pos-pic" aria-label="The picture of the order: change it"/)
    expect(pictureDoorOf(row('DRAFT'))).toEqual({ kind: 'request', id: 'draft-1' })
    expect(pictureDoorOf(row('ORDER', { life: 'WITHDRAWN' }))).toBeNull()
    expect(pictureDoorOf(row('ORDER', { may: { edit: false, send: false, delete: false, takeBack: false, picture: false } }))).toBeNull()
  })

  it('every Waits · news chip is a door: a message → the chat · the design → the design · the rest → the order', () => {
    const chips = waitChipsOf([{ kind: 'LATE', count: null }, { kind: 'DESIGN_APPROVAL', count: null }, { kind: 'NEW_MESSAGES', count: 2 }, { kind: 'ASKED', count: 0 }])
    expect(chips.map((chip) => [chip.kind, chip.door])).toEqual([['NEW_MESSAGES', 'chat'], ['DESIGN_APPROVAL', 'design'], ['LATE', 'page']])
    const html = render(createElement(WaitsChips, { chips }), 'it')
    expect(html.match(/<button type="button" class="fw-pos-chip"/g)).toHaveLength(3)
    expect(textOf(html)).toContain('2 nuovi')
  })

  it('Details: the own columns the row uses, every line’s values; the list draws OwnChips, a life chip and the picture button on the phone card too', () => {
    const details = detailsOf(row('ORDER'), [{ id: 'c-remake', name: 'Remake', kind: 'YES_NO', choices: [], closed: false, version: 1 }, { id: 'c-other', name: 'Other', kind: 'TEXT', choices: [], closed: false, version: 1 }])
    expect(details.columns.map((column) => column.id)).toEqual(['c-remake'])
    expect(details.lines).toEqual([{ 'c-remake': true }])
    const list = readFileSync(new URL('../view/OrdersListView.tsx', import.meta.url), 'utf8')
    expect(list).toContain('<OwnChips columns={details.columns} lines={details.lines} />')
    expect(list).toMatch(/StateChip life=\{lifeOf\(row\.order\)!\}/)
    expect(list).toMatch(/const cardPicture = \(row: ListRow, view: ListRowView\)/)
  })

  it('on a phone (and any screen with no hover) the camera always shows; no sideways scroll from the drafts bar (it wraps)', () => {
    const css = readFileSync(new URL('./sheet.css', import.meta.url), 'utf8')
    expect(css).toMatch(/@media \(max-width: 719px\), \(hover: none\) \{\n  \.fw-pos-cam \{ opacity: 1; \}/)
    expect(css).toMatch(/\.fw-pos-drafts \{ display: flex; flex-wrap: wrap;/)
  })

  it('the gallery cases (empty, drafts, sent, late, many columns) draw in both languages with no key left', () => {
    const cases = everyCase(designScreen)
    expect(new Set(cases.map(([, id]) => id))).toEqual(new Set(['empty', 'drafts', 'sent', 'late', 'columns']))
    for (const [locale, id, html] of cases) expect(leftKeys(html, ['ordersSheet', 'waits', 'own', 'chips']), `${locale} ${id}`).toEqual([])
  })
})

describe('owb-po7b (po7.1): the portal page mounts S2\u2019s ONE sheet part, kind portal, with no price key', () => {
  const t = createTranslator('en', CATALOGUE.en['portal-ordering'] ?? {})
  const ctx = { locale: 'en' as const, t, ownColumns: [{ id: 'c-remake', name: 'Remake', kind: 'YES_NO' as const, choices: [], closed: false, version: 1 }] }

  it('the page draws OrdersSheet with kind "portal", the portal columns and its pictures by record (requests under requestIds)', () => {
    const page = readFileSync(new URL('../OrdersPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(/<OrdersSheet\n\s+kind="portal"\n\s+orders=\{sheetOrders\}\n\s+columns=\{PORTAL_SHEET_COLUMNS\}/)
    expect(page).toMatch(/sourceOf: \(record\) => \(record\.kind === 'REQUEST' \? 'customerRequest' : 'customerOrder'\)/)
    expect(page).toContain('{sheetMode ? sheet : list}')
    expect(PORTAL_SHEET_COLUMNS).toEqual(['what', 'wanted', 'promised', 'where', 'news', 'material', 'sizes', 'pieces', 'details', 'act'])
    expect(PORTAL_SHEET_FILTERS).toEqual(['ALL', 'OPEN', 'SHIPPED', 'DELIVERED'])
  })

  it('every row kind becomes the part\u2019s order: ORDER an order, a Sent or Draft request a request; only a draft is typed in place', () => {
    const order = sheetOrderOf(row('ORDER'), ctx)
    const sent = sheetOrderOf(row('REQUEST'), ctx)
    const draft = sheetOrderOf(row('DRAFT'), ctx)
    expect([order.record.kind, sent.record.kind, draft.record.kind]).toEqual(['ORDER', 'REQUEST', 'REQUEST'])
    expect([order.life, sent.life, draft.life]).toEqual(['CONFIRMED', 'SENT', 'DRAFT'])
    expect([order.may.editLines, sent.may.editLines, draft.may.editLines]).toEqual([null, null, 'DRAFT'])
    expect(draft.may).toMatchObject({ send: true, deleteDraft: true, withdraw: false })
    expect(order.number).toBe('Your order 12')
    expect(order.lines[0]).toMatchObject({ key: 'order-1:l-1', text: 'Alpha race suit', material: 'Cowhide black', own: [{ columnId: 'c-remake', name: 'Remake', kind: 'YES_NO', value: true }] })
    expect(lineIdOfKey(order.lines[0]!.key)).toBe('l-1')
    expect(order.chips).toEqual([{ tone: 'info', icon: 'message-circle', words: '1 new', door: { kind: 'page', target: 'chat:order-1' } }])
  })

  it('no price key in anything the part is given, even from a price holder\u2019s read; a withdrawn row only behind its chip', () => {
    const rows = [row('ORDER'), row('REQUEST'), row('DRAFT'), row('REQUEST', { id: 'gone-1', life: 'WITHDRAWN' })]
    expect(keysOf(rows).some((key) => MONEY.test(key))).toBe(true)
    expect(keysOf(sheetOrdersOf(rows, ctx, true)).filter((key) => MONEY.test(key))).toEqual([])
    expect(sheetOrdersOf(rows, ctx, false).map((entry) => entry.key)).toEqual(['order-1', 'request-1', 'draft-1'])
    expect(sheetOrdersOf(rows, ctx, true)).toHaveLength(4)
  })
})
