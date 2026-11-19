import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { I18nProvider } from '../../i18n/provider'
import { BRAND_ALPHA, BRAND_BETA } from '../../testing/two-brands'
import { scanText } from '../../testing/brand-scan'
import type { ThreadFile } from '../files/model'
import { designScreen } from './fixtures'
import { bulkReach, filesGroups, keepLines, rangeOf, START_AUDIENCE } from './model'
import { uploadAskHeld } from './model' // B-TH-283
import { isOwnFile, orderBulkReach, orderFilesOf, orderGroupsShown, orderLeftOut, sourceOf, type OrderFile, type OrderFilesRead } from './model' // F-SA-237
import { OrderFilesBody } from './view/FilesView' // F-SA-237
import { orderPricedLeftOut, pricedLockedIn, uploadPricedHeld } from './model' // F-CP-144

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so the Files view's rows are read.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * B-TH-299 — the Files view (T9): groups (by kind until the origin is known, then by origin), versions as one document, the
 * bulk bar's reach (Share only with THIS record's party, W13/W25; a legal hold refuses Delete), only this record's files —
 * tabs with their own file API stay out (R-1 to R-4, W26) —, the keep lines, the upload starting on Office, every case in
 * it and en.
 */

const KEY_ON_SCREEN = /\b(title|subtitle|missing|refused|forbidden|problem|empty|upload|select|bulk|group|version|keep|design)\.[a-zA-Z]/
const RECORD = { type: 'SalesOrder', id: 'so-beta' }
const PARTY = { id: 'party-beta', role: 'customer' as const }
const ALL = { upload: true, share: true, delete: true }

const file = (over: Partial<ThreadFile>): ThreadFile => ({
  id: 'f',
  recordType: RECORD.type,
  recordId: RECORD.id,
  name: 'x.pdf',
  contentType: 'application/pdf',
  kind: 'DOCUMENT',
  sizeBytes: 1,
  status: 'AVAILABLE',
  quarantineReason: null,
  visibility: ['OFFICE'],
  partyId: null,
  createdAt: '2026-11-10T09:00:00.000Z',
  previewUrl: null,
  ...over,
})

describe('groups and versions', () => {
  it('groups by the system’s kind until every file says where it came from, then by origin; empty groups hidden', () => {
    const files = [file({ id: 'p', name: 'p.jpg', kind: 'PHOTO', contentType: 'image/jpeg' }), file({ id: 'd', name: 'd.pdf' }), file({ id: 'c', name: 'c.pdf', kind: 'CERTIFICATE' })]
    expect(filesGroups(files, RECORD).map((group) => group.key)).toEqual(['kind:PHOTO', 'kind:DOCUMENT', 'kind:CERTIFICATE'])
    const known = [file({ id: 'a', name: 'a.pdf', origin: 'party' }), file({ id: 'b', name: 'b.pdf', origin: 'made' })]
    expect(filesGroups(known, RECORD).map((group) => group.key)).toEqual(['origin:party', 'origin:made'])
    // One file without an origin: no half-true origin groups.
    expect(filesGroups([...known, file({ id: 'n', name: 'n.pdf' })], RECORD).every((group) => group.group.by === 'kind')).toBe(true)
  })

  it('shows a document once, its version in force on top and the earlier ones under it', () => {
    const groups = filesGroups([file({ id: 'v1', versionNo: 1 }), file({ id: 'v2', versionNo: 2, seriesId: 'v1', createdAt: '2026-11-12T09:00:00.000Z' })], RECORD)
    expect(groups[0]!.series).toHaveLength(1)
    expect(groups[0]!.series[0]!.latest.id).toBe('v2')
    expect(groups[0]!.series[0]!.earlier.map((one) => one.id)).toEqual(['v1'])
  })

  it('never lists another record’s file: tabs with their own file API keep theirs (R-1 to R-4, W26)', () => {
    const groups = filesGroups([file({ id: 'own', name: BRAND_BETA.fileName }), file({ id: 'wo', name: 'wo.pdf', recordType: 'WorkOrder', recordId: 'wo-1' }), file({ id: 'alpha', recordId: 'so-alpha', name: BRAND_ALPHA.fileName })], RECORD)
    const ids = groups.flatMap((group) => group.series.map((one) => one.latest.id))
    expect(ids).toEqual(['own'])
    expect(scanText(JSON.stringify(groups), BRAND_ALPHA)).toEqual([])
  })
})

describe('the bulk bar', () => {
  const shared = file({ id: 's', name: 's.pdf', visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id })
  const office = file({ id: 'o', name: 'o.pdf' })
  const held = file({ id: 'h', name: 'h.pdf', legalHold: true, visibility: ['OFFICE', 'PARTNER'], partyId: PARTY.id })
  const quarantined = file({ id: 'q', name: 'q.pdf', status: 'QUARANTINED', quarantineReason: 'scan_pending' })

  it('counts only what each action is allowed for', () => {
    const reach = bulkReach([shared, office, held, quarantined], PARTY, ALL)
    expect(reach.download).toEqual(['s', 'o', 'h'])
    expect(reach.share).toEqual(['o'])
    expect(reach.officeOnly).toEqual(['s', 'h'])
    expect(reach.remove).toEqual(['s', 'o', 'q'])
    expect(reach.onHold).toBe(1)
  })

  it('shares only with THIS record’s party: none without a party or without the right (W13, W25)', () => {
    // A file shared with another party counts as not shared with this one: Share puts it on this party, never the other.
    const elsewhere = file({ id: 'e', visibility: ['OFFICE', 'PARTNER'], partyId: 'party-alpha' })
    expect(bulkReach([elsewhere], PARTY, ALL).share).toEqual(['e'])
    expect(bulkReach([office], null, ALL).share).toEqual([])
    expect(bulkReach([office], PARTY, { ...ALL, share: false }).share).toEqual([])
    expect(bulkReach([office], PARTY, { ...ALL, delete: false })).toMatchObject({ remove: [], onHold: 0 })
  })

  it('shift-click chooses the range in the window’s order', () => {
    expect(rangeOf(['a', 'b', 'c', 'd'], 'b', 'd')).toEqual(['b', 'c', 'd'])
    expect(rangeOf(['a', 'b', 'c', 'd'], 'd', 'a')).toEqual(['a', 'b', 'c', 'd'])
    expect(rangeOf(['a', 'b'], null, 'b')).toEqual(['b'])
  })
})

describe('the keep lines and the upload', () => {
  const now = Date.UTC(2026, 10, 17)
  it('says held, legal hold and retention read-only', () => {
    expect(keepLines(file({ status: 'QUARANTINED', quarantineReason: 'scan_pending' }), now)[0]).toMatchObject({ key: 'keep.scanPending', tone: 'warning' })
    expect(keepLines(file({ status: 'QUARANTINED', quarantineReason: 'virus_found' }), now)[0]).toMatchObject({ key: 'keep.infected', tone: 'danger' })
    expect(keepLines(file({ legalHold: true }), now).map((line) => line.key)).toEqual(['keep.legalHold'])
    expect(keepLines(file({ retainUntil: '2036-12-31T23:00:00.000Z' }), now)[0]).toMatchObject({ key: 'keep.until' })
    expect(keepLines(file({ retainUntil: '2026-11-01T00:00:00.000Z' }), now)[0]).toMatchObject({ key: 'keep.due' })
  })

  it('starts an upload on Office', () => {
    expect(START_AUDIENCE).toBe('OFFICE')
  })
})

describe('the words', () => {
  it('has the words of every group, audience and plural, in it and en', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view'] ?? {})
      for (const key of ['PHOTO', 'DOCUMENT', 'CERTIFICATE', 'ATTACHMENT', 'AUDIO', 'FISCAL_ARCHIVE'].map((kind) => `group.kind.${kind}`).concat(['group.origin.ours', 'group.origin.made', 'group.origin.floor', 'group.origin.party.customer', 'group.origin.party.supplier'], ['OFFICE', 'FLOOR', 'PARTNER', 'LINK'].flatMap((audience) => [`upload.audience.${audience}`, `upload.audience.${audience}Body`]))) {
        expect(t(key), `${locale} ${key}`).not.toBe(key)
      }
      expect(t('subtitle', { count: 1 })).not.toBe(t('subtitle', { count: 2 }))
    }
  })

  it('draws every case of SCR-006-filesview with no key on screen', () => {
    for (const item of designScreen.cases) {
      for (const locale of LOCALES) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
        expect(html, `${item.id} ${locale}`).not.toMatch(KEY_ON_SCREEN)
      }
    }
  })
})

// ---- B-TH-283 (B-TH-083): measurement sheets in the Files view — the lock by right, the recorded opening, the tick at upload.
describe('B-TH-283: measurement sheets are body data in the Files view', () => {
  const draw = (locale: 'it' | 'en', id: string) => {
    const item = designScreen.cases.find((one) => one.id === id)!
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
  }

  it('who may not open a sheet reads the lock and why, never its name; who may, that each opening is recorded (W25, W26)', () => {
    const html = draw('en', 'sheets')
    expect(html).toContain('Measurement sheet — you cannot open it')
    // B-W2b-F51: the right in words, never its code.
    expect(html).toContain('It opens with the right to read measurements; each opening is recorded.')
    expect(html).not.toContain('sales.measurements.view')
    expect(html).toContain('Measurement sheet: body data — each opening is recorded.')
    expect(draw('it', 'sheets')).toContain('ogni apertura viene registrata')
    expect(scanText(html, BRAND_BETA)).toEqual([])
  })

  it('a locked sheet is neither downloaded nor shared by who may not open it; an opened sheet may be', () => {
    const locked = file({ id: 'l', name: '', locked: 'MEASUREMENTS' })
    const open = file({ id: 'o', name: 'Measurements.pdf', sheet: true })
    expect(bulkReach([locked, open], PARTY, ALL).download).toEqual(['o'])
  })

  it('the upload asks “This is a measurement sheet”; a sheet never goes to the floor (Add held with why)', () => {
    expect(uploadAskHeld({ sheet: true, audience: 'FLOOR' })).toBe('upload.sheetFloor')
    expect(uploadAskHeld({ sheet: true, audience: 'OFFICE' })).toBeNull()
    expect(uploadAskHeld({ sheet: false, audience: 'FLOOR' })).toBeNull()
    // The upload window is a DS Modal (drawn after hydration only): its words are checked in the catalogue, in it and en.
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view'] ?? {})
      for (const key of ['upload.sheet', 'upload.sheetHint', 'upload.sheetFloor', 'upload.sheetType']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
    const en = createTranslator('en', messagesFor('en', ['record-thread-files-view'])['record-thread-files-view'] ?? {})
    expect(en('upload.sheet')).toBe('This is a measurement sheet')
    expect(en('upload.sheetFloor')).toContain('never goes to the floor')
    expect(draw('en', 'upload-sheet')).not.toMatch(KEY_ON_SCREEN)
  })
})
// ---- end B-TH-283

// ---- F-SA-237: a SALES ORDER's files from its one walled read — the same body on the order's Files tab and in this window ----------
describe('F-SA-237 — the order files body: groups by source, who can see each file, also on, counted left-outs', () => {
  const ORDER = { id: 'so-alpha', number: 'SO-2026-0142' }
  const orderFile = (id: string, over: Partial<OrderFile> = {}): OrderFile => ({
    id,
    name: `${id}.pdf`,
    kind: 'DOCUMENT',
    category: null,
    contentType: 'application/pdf',
    sizeBytes: 2048,
    versionNo: 1,
    at: '2026-11-12T10:00:00Z',
    from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number },
    line: null,
    audience: 'OFFICE_ONLY',
    bodyData: false,
    alsoOn: [],
    alsoOnOther: 0,
    inThread: null,
    ...over,
  })
  const READ: OrderFilesRead = {
    order: ORDER,
    groups: [
      { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [orderFile('sheet', { audience: 'CUSTOMER_CAN_SEE', inThread: { messageId: 'm1' } }), orderFile('notes')], leftOut: 0, measurementsLeftOut: 0 },
      { key: 'LINES', words: { en: 'Lines & artwork', it: 'Righe e grafiche' }, files: [orderFile('logo', { from: { type: 'SalesOrderLine', id: 'l1', label: 'SO-2026-0142 · line 10' }, alsoOn: [{ type: 'SalesOrder', id: 'so-0151', label: 'SO-2026-0151' }], alsoOnOther: 1 })], leftOut: 0, measurementsLeftOut: 1 },
      { key: 'PRODUCTION', words: { en: 'Production', it: 'Produzione' }, files: [orderFile('photo', { kind: 'PHOTO', from: { type: 'WorkOrder', id: 'w1', label: 'WO-2026-0311' } })], leftOut: 2, measurementsLeftOut: 0 },
      { key: 'RETURNS', words: { en: 'Returns & complaints', it: 'Resi e reclami' }, files: [], leftOut: 0, measurementsLeftOut: 0 },
    ],
    total: 4,
    truncated: false,
  }

  it('groups by source in the read’s order (an empty group says nothing); files the reader may not open are counted, never named', () => {
    expect(orderGroupsShown(READ).map((group) => group.key)).toEqual(['ORDER', 'LINES', 'PRODUCTION'])
    expect(orderLeftOut(READ)).toBe(3)
    expect(orderFilesOf(READ).map((entry) => entry.id)).toEqual(['sheet', 'notes', 'logo', 'photo'])
  })

  it('where a file sits, and the bulk bar: Download every chosen file; Share only the order’s own office-only files, with the right', () => {
    expect(sourceOf(orderFile('a', { inThread: { messageId: 'm' } }), ORDER.id)).toEqual({ key: 'order.source.thread' })
    expect(sourceOf(orderFile('a'), ORDER.id)).toEqual({ key: 'order.source.order' })
    expect(sourceOf(orderFile('a', { from: { type: 'WorkOrder', id: 'w1', label: 'WO-2026-0311' } }), ORDER.id)).toEqual({ key: 'order.source.from', params: { record: 'WO-2026-0311' } })
    const chosen = orderFilesOf(READ)
    expect(orderBulkReach(chosen, ORDER.id, true)).toEqual({ download: ['sheet', 'notes', 'logo', 'photo'], share: ['notes'] })
    expect(orderBulkReach(chosen, ORDER.id, false).share).toEqual([])
    expect(isOwnFile(orderFile('x', { from: { type: 'SalesOrderLine', id: 'l1', label: 'line' } }), ORDER.id)).toBe(false)
  })

  it('the body in both languages: the audience on every file, the source chip, also on as the read names it, Open in the conversation', () => {
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(OrderFilesBody, { model: { read: READ, problem: null, selected: [], canShare: true }, party: { name: 'Brand Alpha' }, actions: { onOrderMessage: () => undefined } })))
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      for (const words of [t('order.audience.CUSTOMER_CAN_SEE'), t('order.audience.OFFICE_ONLY'), t('order.source.thread'), t('order.alsoOn', { record: 'SO-2026-0151' }), t('order.alsoOnOther', { count: 1 }), t('order.inThread'), t('order.leftOut', { count: 3 }), locale === 'en' ? 'Lines &amp; artwork' : 'Righe e grafiche']) expect(html, words).toContain(words)
      expect(html.match(/\border\.[a-zA-Z]+/)?.[0] ?? null, locale).toBeNull()
      expect(html).not.toContain('Returns')
    }
  })

  it('the SalesOrder switch: the window draws the order body when given the order read; every other record keeps its own list', () => {
    const view = readFileSync(new URL('./view/FilesView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('{model.order ? (')
    expect(view).toContain('<OrderFilesView model={model.order} party={model.party} actions={actions} place="window" />') // F-OP-125: narrower cards
    const thread = readFileSync(new URL('../../../areas/_shared/record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(thread).toContain("order: key.type === 'SalesOrder' ? orderFiles.model : null,")
    const tab = readFileSync(new URL('../../../areas/sales/orders/record/view/FilesTab.tsx', import.meta.url), 'utf8')
    expect(tab).toContain('<OrderFilesBody model={files}')
  })
})
// ---- end F-SA-237

// ---- F-OP-125 (order page N7 "files like Gmail"; 10-order-page §9.1; N-1): the order's file cards and the page's one container ----
describe('F-OP-125: Gmail cards — kinds, the lock card, who added it (office only), the MTM worksheets, one read per page', () => {
  const ORDER = { id: 'so-alpha', number: 'SO-2026-0142' }
  const card = (id: string, over: Partial<OrderFile> = {}): OrderFile => ({
    id,
    name: `${id}.pdf`,
    kind: 'DOCUMENT',
    category: null,
    contentType: 'application/pdf',
    sizeBytes: 1_258_291,
    versionNo: 1,
    at: '2026-11-12T10:00:00Z',
    from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number },
    line: null,
    audience: 'OFFICE_ONLY',
    bodyData: false,
    alsoOn: [],
    alsoOnOther: 0,
    inThread: null,
    addedBy: null,
    ...over,
  })
  const sheet = { documentId: 'doc-1', profileId: 'prof-1', line: { id: 'l2', seq: 20 }, version: 2, number: 'WS-0007', language: 'it', createdAt: '2026-11-13T09:00:00Z' }
  const READ: OrderFilesRead = {
    order: ORDER,
    groups: [
      { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [card('spec', { addedBy: { kind: 'PERSON', name: 'Demo Planner' } }), card('photo', { name: 'Collar.jpg', kind: 'PHOTO', contentType: 'image/jpeg', addedBy: { kind: 'FLOOR', name: null } })], leftOut: 0, measurementsLeftOut: 0 },
      { key: 'LINES', words: { en: 'Lines & artwork', it: 'Righe e grafiche' }, files: [card('measures', { name: 'Rider measures.jpg', kind: 'PHOTO', contentType: 'image/jpeg', bodyData: true }), card('sizes', { name: 'Sizes.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', addedBy: { kind: 'CUSTOMER', name: BRAND_ALPHA.tradeName } })], worksheets: [sheet], leftOut: 0, measurementsLeftOut: 1 },
    ],
    total: 4,
    truncated: false,
  }
  const draw = (locale: 'it' | 'en', model: Parameters<typeof OrderFilesBody>[0]['model'], place: 'tab' | 'window' = 'tab') => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(OrderFilesBody, { model, party: { name: BRAND_ALPHA.tradeName }, actions: { onOrderMessage: () => undefined }, place })))

  it('a card\'s kind is the previews route\'s rule: body data is LOCKED whatever it is; pictures; PDFs; anything else is its kind\'s card', async () => {
    const { cardKindOf } = await import('./model')
    expect(cardKindOf(card('a'))).toBe('PDF')
    expect(cardKindOf(card('b', { contentType: 'image/heic' }))).toBe('PICTURE')
    expect(cardKindOf(card('c', { contentType: 'application/zip' }))).toBe('OTHER')
    expect(cardKindOf(card('d', { contentType: 'image/jpeg', bodyData: true }))).toBe('LOCKED')
  })

  it('the facts line: the type as a mail client says it, the size, the day; "added by" a person, the customer, or "the floor" (never a worker)', async () => {
    const { addedByOf, typeLabelOf } = await import('./model')
    expect([typeLabelOf(card('a')), typeLabelOf(card('b', { name: 'Sizes.xlsx' })), typeLabelOf(card('c', { name: 'scan', contentType: 'image/png' })), typeLabelOf(card('d', { name: 'notes', contentType: 'application/vnd.ms-excel' }))]).toEqual(['PDF', 'XLSX', 'PNG', ''])
    expect(addedByOf(card('a', { addedBy: { kind: 'PERSON', name: 'Demo Planner' } }))).toEqual({ key: 'card.addedBy', params: { name: 'Demo Planner' } })
    expect(addedByOf(card('a', { addedBy: { kind: 'FLOOR', name: 'Someone' } }))).toEqual({ key: 'card.addedByFloor' })
    expect(addedByOf(card('a', { addedBy: { kind: 'CUSTOMER', name: null } }))).toBeNull()
    expect(addedByOf(card('a'))).toBeNull()
  })

  it('cards in both languages: the grid, the lock card for body data (never a picture), who added it, Download; no key on screen', () => {
    for (const locale of LOCALES) {
      const html = draw(locale, { read: READ, problem: null, selected: [], canShare: true })
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      for (const words of [t('card.bodyData'), t('card.addedBy', { name: 'Demo Planner' }), t('card.addedByFloor'), t('card.addedBy', { name: BRAND_ALPHA.tradeName }), t('card.download'), t('card.worksheet', { line: 20, version: 2 }), t('order.leftOut', { count: 1 })]) expect(html, `${locale}: ${words}`).toContain(words)
      expect(html).toContain('class="fw-rtv-cards"')
      expect(html.match(/\b(card|order)\.[a-zA-Z]+/)?.[0] ?? null, locale).toBeNull()
      // The body photo is a lock card: no <img> of it, ever (its previews come in F-OP-126, never for body data).
      expect(html).not.toMatch(/<img[^>]*Rider measures/)
    }
    // The thread's Files window draws narrower cards.
    expect(draw('en', { read: READ, problem: null, selected: [], canShare: true }, 'window')).toContain('fw-rtv-order is-window')
  })

  it('B5: the worksheets the read sends show in Lines as lock cards; without the measurements right they are counted, never named', async () => {
    const { cardOrderOf, orderWorksheetsOf, worksheetCardId } = await import('./model')
    expect(orderWorksheetsOf(READ.groups[1]!)).toEqual([sheet])
    expect(cardOrderOf(READ)).toEqual(['spec', 'photo', 'measures', 'sizes', worksheetCardId(sheet)])
    const withoutRight: OrderFilesRead = { ...READ, groups: READ.groups.map((group) => ({ ...group, worksheets: [] })) }
    const html = draw('en', { read: withoutRight, problem: null, selected: [], canShare: true })
    expect(html).not.toContain('Worksheet · line')
    expect(orderLeftOut(withoutRight)).toBe(1)
    // The customer's face: no worksheet, no "added by", no box.
    const customer = draw('en', { read: READ, problem: null, selected: [], canShare: false, face: 'customer' })
    for (const never of ['Worksheet · line', 'added by', 'type="checkbox"']) expect(customer, never).not.toContain(never)
  })

  it('the keys walk the grid: ← / → by one card, ↑ / ↓ by one row, no wrap', async () => {
    const { cardStep } = await import('./model')
    expect(cardStep(0, 7, 'ArrowRight', 3)).toBe(1)
    expect(cardStep(0, 7, 'ArrowLeft', 3)).toBeNull()
    expect(cardStep(1, 7, 'ArrowDown', 3)).toBe(4)
    expect(cardStep(5, 7, 'ArrowDown', 3)).toBeNull()
    expect(cardStep(4, 7, 'ArrowUp', 3)).toBe(1)
  })

  it('one read per page: OrderRecord mounts THE container once and keeps its read across tabs; news reads it again when wanted', () => {
    const page = readFileSync(new URL('../../../areas/sales/orders/record/OrderRecord.tsx', import.meta.url), 'utf8')
    expect(page.match(/useOrderFiles\(api, \{/g)).toHaveLength(1)
    expect(page).toContain('keep: true, // F-OP-125')
    expect(page).toContain('files: orderFiles.model, // F-SA-237; F-OP-125')
    expect(page).toContain("if (parts.includes('files')) orderFiles.reload()")
    const hook = readFileSync(new URL('../../../areas/_shared/record-thread/use-order-files.ts', import.meta.url), 'utf8')
    expect(hook).toContain('if (enabled && readFor.current !== orderId) load()')
    expect(hook).toContain('if (!enabled && !keep) readFor.current = null')
    expect(hook).toContain('openWorksheet(api, sheet.profileId, sheet.documentId)')
  })
})
// ---- end F-OP-125

// ---- F-OP-126 (order page N7; 10-order-page §9.2; review R-14): lazy previews — only cards in view, ≤ 24 a call, PDF page 1 here ----
describe('F-OP-126: lazy previews — visible-only asks, the cache by address expiry, the PDF cap and queue, the session LRU', () => {
  const NOW = Date.parse('2026-11-19T10:00:00Z')
  const file = (id: string, over: Partial<OrderFile> = {}) => ({ id, versionNo: 1, contentType: 'image/jpeg', bodyData: false, sizeBytes: 200_000, ...over })

  it('asks only the cards in view, in view order, at most 24 a call; never body data, a large PDF or a kind no browser draws', async () => {
    const { asksPreview, PREVIEW_BATCH_MAX, wantedOf } = await import('./use-file-previews')
    const files = new Map<string, ReturnType<typeof file>>(Array.from({ length: 30 }, (_, n) => [`p${n}`, file(`p${n}`)] as const)) // op-fx1: any file id, not only p…
    files.set('body', file('body', { bodyData: true }))
    files.set('big', file('big', { contentType: 'application/pdf', sizeBytes: 3 * 1024 * 1024 + 1 }))
    files.set('small-pdf', file('small-pdf', { contentType: 'application/pdf', sizeBytes: 3 * 1024 * 1024 }))
    files.set('zip', file('zip', { contentType: 'application/zip' }))
    const visible = ['body', 'big', 'zip', 'small-pdf', ...Array.from({ length: 30 }, (_, n) => `p${n}`)]
    const asked = wantedOf(visible, files, new Map(), new Set(), NOW)
    expect(asked).toHaveLength(PREVIEW_BATCH_MAX)
    expect(asked[0]).toBe('small-pdf')
    expect(asked).not.toContain('body')
    expect(asked).not.toContain('big')
    expect(asked).not.toContain('zip')
    // Not in view: never asked; on its way: not asked twice.
    expect(wantedOf([], files, new Map(), new Set(), NOW)).toEqual([])
    expect(wantedOf(['p1', 'p2'], files, new Map(), new Set(['p1']), NOW)).toEqual(['p2'])
    expect([asksPreview(file('a', { contentType: 'image/heic' })), asksPreview(file('b', { contentType: 'application/pdf', sizeBytes: 100 })), asksPreview(file('c', { bodyData: true }))]).toEqual([true, true, false])
  })

  it('a picture is kept until its address expires (less 5 s) and asked again then, while in view; one not made yet, a minute later', async () => {
    const { EXPIRY_MARGIN_MS, freshOf, keptPicture, keyOf, NOT_MADE_AGAIN_MS, wantedOf } = await import('./use-file-previews')
    const kept = keptPicture({ small: { url: 'https://store.example.com/s1?sig=1', expiresAt: new Date(NOW + 60_000).toISOString() } }, NOW)
    expect(kept).toEqual({ preview: { kind: 'picture', src: 'https://store.example.com/s1?sig=1' }, until: NOW + 60_000 - EXPIRY_MARGIN_MS })
    expect(freshOf(kept, NOW + 54_000)).toBe(true)
    expect(freshOf(kept, NOW + 56_000)).toBe(false)
    const files = new Map([['s1', file('s1')]])
    const cache = new Map([[keyOf(file('s1')), kept]])
    expect(wantedOf(['s1'], files, cache, new Set(), NOW + 10_000)).toEqual([])
    expect(wantedOf(['s1'], files, cache, new Set(), NOW + 56_000)).toEqual(['s1'])
    // A new version is another key: asked again at once.
    expect(wantedOf(['s1'], new Map([['s1', file('s1', { versionNo: 2 })]]), cache, new Set(), NOW)).toEqual(['s1'])
    expect(keptPicture({ small: null }, NOW)).toEqual({ preview: { kind: 'icon' }, until: NOW + NOT_MADE_AGAIN_MS })
  })

  it('a PDF over 3 MiB says "Large PDF: open it to see it" without a call; pages are drawn 2 at a time and the session keeps 60', async () => {
    const { knownWithoutAsking, Lru, PDF_DRAWS_AT_ONCE, PDF_PAGES_KEPT, queueOf } = await import('./use-file-previews')
    expect(knownWithoutAsking(file('big', { contentType: 'application/pdf', sizeBytes: 4 * 1024 * 1024 }))).toEqual({ kind: 'largePdf' })
    expect(knownWithoutAsking(file('ok', { contentType: 'application/pdf', sizeBytes: 1024 }))).toBeNull()
    expect([PDF_DRAWS_AT_ONCE, PDF_PAGES_KEPT]).toEqual([2, 60])
    // The queue: never more than 2 running.
    const queue = queueOf(2)
    let running = 0
    let most = 0
    const job = () => new Promise<void>((resolve) => {
      running += 1
      most = Math.max(most, running)
      setTimeout(() => {
        running -= 1
        resolve()
      }, 5)
    })
    await Promise.all(Array.from({ length: 6 }, () => queue(job)))
    expect(most).toBe(2)
    // The LRU keeps the newest; reading one makes it the newest.
    const lru = new Lru<string>(2)
    lru.set('a', '1')
    lru.set('b', '2')
    expect(lru.get('a')).toBe('1')
    lru.set('c', '3')
    expect([lru.get('a'), lru.get('b'), lru.get('c'), lru.size]).toEqual(['1', undefined, '3', 2])
  })

  it('the code: one batch route (never the generic /files/:id/preview), no iframe / embed / object, the body reports what is in view', () => {
    const api = readFileSync(new URL('../../../areas/_shared/record-thread/api.ts', import.meta.url), 'utf8')
    expect(api).toContain('`/sales/orders/${enc(orderId)}/files/previews`')
    const hook = readFileSync(new URL('./use-file-previews.ts', import.meta.url), 'utf8')
    const view = readFileSync(new URL('./view/FilesView.tsx', import.meta.url), 'utf8')
    for (const source of [hook, view]) {
      expect(source).not.toMatch(/\/files\/[^`'"]*\/preview\b/)
      expect(source).not.toMatch(/<(iframe|embed|object)\b/)
    }
    expect(view).toContain("{ rootMargin: '200px' }")
    expect(view).toContain('report.current?.(order())')
    const container = readFileSync(new URL('../../../areas/_shared/record-thread/use-order-files.ts', import.meta.url), 'utf8')
    expect(container).toContain('readOrderFilePreviews(api, orderId, fileIds)')
    // links/approve draws its PDF page with the one helper, moved to lib/pdf.
    expect(readFileSync(new URL('../../../links/approve/Approve.tsx', import.meta.url), 'utf8')).toContain("from '../../lib/pdf/pdf-page'")
  })

  it('the card draws what came: the small picture, PDF page 1, "Large PDF…", else the kind\'s icon; body data never a picture', () => {
    const ORDER = { id: 'so-alpha', number: 'SO-2026-0142' }
    const base = { kind: 'DOCUMENT', category: null, versionNo: 1, at: '2026-11-12T10:00:00Z', from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number }, line: null, audience: 'OFFICE_ONLY' as const, bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null }
    const files: OrderFile[] = [
      { ...base, id: 'pic', name: 'Collar.jpg', contentType: 'image/jpeg', sizeBytes: 900_000 },
      { ...base, id: 'pdf', name: 'Spec.pdf', contentType: 'application/pdf', sizeBytes: 200_000 },
      { ...base, id: 'big', name: 'Catalogue.pdf', contentType: 'application/pdf', sizeBytes: 9_000_000 },
      { ...base, id: 'body', name: 'Rider.jpg', contentType: 'image/jpeg', sizeBytes: 400_000, bodyData: true },
    ]
    const read: OrderFilesRead = { order: ORDER, groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files, leftOut: 0, measurementsLeftOut: 0 }], total: 4, truncated: false }
    const previews = { pic: { kind: 'picture' as const, src: 'https://store.example.com/small/pic' }, pdf: { kind: 'page' as const, src: 'data:image/png;base64,AAAA' }, big: { kind: 'largePdf' as const }, body: { kind: 'picture' as const, src: 'https://store.example.com/never' } }
    const html = renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(OrderFilesBody, { model: { read, problem: null, selected: [], canShare: false, previews }, party: null })))
    expect(html).toContain('src="https://store.example.com/small/pic"')
    expect(html).toContain('src="data:image/png;base64,AAAA"')
    expect(html).toContain('Large PDF: open it to see it')
    expect(html).not.toContain('store.example.com/never')
    expect(html).toContain('data-card-id="pic"')
  })
})
// ---- end F-OP-126

// ---- F-OP-127 (order page N7; 10-order-page §9.3): one viewer walk — every file in display order, body data only when asked ----
describe('F-OP-127: one viewer — ← / → over every file in display order, a lock card for body data, Download at the click', () => {
  const ORDER = { id: 'so-alpha', number: 'SO-2026-0142' }
  const base = { kind: 'DOCUMENT', category: null, versionNo: 1, at: '2026-11-12T10:00:00Z', from: { type: 'SalesOrder', id: ORDER.id, label: ORDER.number }, line: null, audience: 'OFFICE_ONLY' as const, bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null, sizeBytes: 10_000 }
  const READ: OrderFilesRead = {
    order: ORDER,
    groups: [
      { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [{ ...base, id: 'spec', name: 'Spec.pdf', contentType: 'application/pdf', inThread: { messageId: 'm1' } }, { ...base, id: 'collar', name: 'Collar.jpg', kind: 'PHOTO', contentType: 'image/jpeg' }], leftOut: 0, measurementsLeftOut: 0 },
      { key: 'LINES', words: { en: 'Lines & artwork', it: 'Righe e grafiche' }, files: [{ ...base, id: 'rider', name: 'Rider.jpg', kind: 'PHOTO', contentType: 'image/jpeg', bodyData: true }, { ...base, id: 'sizes', name: 'Sizes.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }], leftOut: 1, measurementsLeftOut: 0 },
    ],
    total: 4,
    truncated: false,
  }

  it('the walk is every listed file in display order across the groups; body data is locked until opened; a source once fetched', async () => {
    const { fetchesOf, viewerFilesOf } = await import('./use-order-file-viewer')
    const walk = viewerFilesOf(orderFilesOf(READ), new Map(), new Set())
    expect(walk.map((file) => [file.id, !!file.locked])).toEqual([
      ['spec', false],
      ['collar', false],
      ['rider', true],
      ['sizes', false],
    ])
    expect(walk[0]!.messageId).toBe('m1')
    // Fetched when shown: a PDF and a photo; never a locked one (it waits for its Open), never a kind no browser draws.
    expect(walk.map((file) => fetchesOf(file, new Map()))).toEqual([true, true, false, false])
    const opened = viewerFilesOf(orderFilesOf(READ), new Map([['collar', 'blob:collar']]), new Set(['rider']))
    expect(opened[2]!.locked).toBe(false)
    expect(fetchesOf(opened[1]!, new Map([['collar', 'blob:collar']]))).toBe(false)
  })

  it('walk="all": a photo is drawn in the viewer\'s window (no Lightbox), "2 of 4", Download a button asked at the click', async () => {
    const { FileViewer } = await import('../popups/view/FileViewer')
    const { viewerFilesOf } = await import('./use-order-file-viewer')
    const walk = viewerFilesOf(orderFilesOf(READ), new Map([['collar', 'blob:collar']]), new Set())
    const draw = (index: number) => renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(FileViewer, { walk: 'all', files: walk, index, onIndex: () => undefined, onClose: () => undefined, onDownload: () => undefined, onOpenLocked: () => undefined })))
    const photo = draw(1)
    expect(photo).toContain('class="fw-rtp-photo" src="blob:collar"')
    expect(photo).toContain('2 of 4')
    expect(photo).toContain('Download')
    expect(photo).not.toContain('download="Collar.jpg"') // never a link fetched before: the click asks it
    // Body data: a lock card that opens only when asked; no Download, no picture.
    const locked = draw(2)
    expect(locked).toContain('Open — this opening is recorded')
    expect(locked).not.toContain('<img')
    expect(locked).not.toContain('Download')
    // A kind no browser draws: its card.
    expect(draw(3)).toContain('Office file: download it to open it in its program.')
  })

  it('the page: Open shows the file in the ONE viewer (the card gets the focus back), Download asks mode download; the body mounts it', () => {
    const container = readFileSync(new URL('../../../areas/_shared/record-thread/use-order-files.ts', import.meta.url), 'utf8')
    expect(container).toContain("onOrderOpen: (fileId, mode, opener) => (mode === 'preview' ? viewer.openAt(fileId, opener ?? null) : void download(fileId)),")
    expect(container).toContain("await openOrderFile(api, orderId, fileId, 'download')")
    expect(container).not.toContain("window.open(url, '_blank', 'noopener')")
    const view = readFileSync(new URL('./view/FilesView.tsx', import.meta.url), 'utf8')
    expect(view).toContain('<FileViewer\n          walk="all"')
    expect(view).toContain('returnFocusTo={model.viewer.returnTo}')
    expect(view).toContain("onClick={(event) => actions?.onOrderOpen?.(file.id, 'preview', event.currentTarget)}")
    const hook = readFileSync(new URL('./use-order-file-viewer.ts', import.meta.url), 'utf8')
    expect(hook).toContain("const answer = await open(file.id, 'preview')")
    expect(hook).toContain('setOpened(new Set())') // closed: body data is locked again
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-popups'])['record-thread-popups']!)
      for (const key of ['viewer.locked', 'viewer.openRecorded']) expect(t(key), `${locale} ${key}`).not.toBe(key)
    }
  })
})
// ---- end F-OP-127

// ---- F-OP-310 (order page walk #19): ONE Download in the viewer — the PDF's toolbar has its own, so the footer has none then ---------
describe('F-OP-310: the file viewer offers ONE Download', () => {
  const base = { kind: 'DOCUMENT', category: null, versionNo: 1, at: '2026-11-12T10:00:00Z', from: { type: 'SalesOrder', id: 'so-alpha', label: 'SO-2026-0142' }, line: null, audience: 'OFFICE_ONLY' as const, bodyData: false, alsoOn: [], alsoOnOther: 0, inThread: null, sizeBytes: 10_000 }
  const READ: OrderFilesRead = {
    order: { id: 'so-alpha', number: 'SO-2026-0142' },
    groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [{ ...base, id: 'spec', name: 'Spec.pdf', contentType: 'application/pdf' }, { ...base, id: 'sizes', name: 'Sizes.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }], leftOut: 0, measurementsLeftOut: 0 }],
    total: 2,
    truncated: false,
  }
  const downloads = (html: string) => (html.match(/Download<\/(button|a)>/g) ?? []).length

  it('a PDF shown: only its toolbar\'s Download (through the host\'s download when it asks one); a card or a PDF still loading: the footer\'s', async () => {
    const { FileViewer } = await import('../popups/view/FileViewer')
    const { viewerFilesOf } = await import('./use-order-file-viewer')
    const draw = (sources: Map<string, string>, index: number, onDownload?: (fileId: string) => void) =>
      renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', ['shell']) }, createElement(FileViewer, { walk: 'all', files: viewerFilesOf(orderFilesOf(READ), sources, new Set()), index, onIndex: () => undefined, onClose: () => undefined, ...(onDownload ? { onDownload } : {}), onOpenLocked: () => undefined })))
    const shown = draw(new Map([['spec', 'blob:spec']]), 0, () => undefined)
    expect(shown).toContain('class="nds-pdf"')
    expect(downloads(shown)).toBe(1)
    expect(downloads(draw(new Map([['spec', 'blob:spec']]), 0))).toBe(1)
    // Still loading (no source yet): no toolbar, the footer's Download.
    expect(downloads(draw(new Map(), 0, () => undefined))).toBe(1)
    // A kind no browser draws: its card and the footer's Download.
    expect(downloads(draw(new Map(), 1, () => undefined))).toBe(1)
    const viewer = readFileSync(new URL('../popups/view/FileViewer.tsx', import.meta.url), 'utf8')
    expect(viewer).toContain("{show !== 'held' && !locked && !pdfShown && download}")
    expect(viewer).toContain('{...(onDownload ? { onDownload: () => onDownload(current.id) } : {})}')
  })
})
// ---- end F-OP-310

// ── F-CP-144 (customer page plan C4, the money wall; design 11-money §4.5; B-CP-014, B-CP-023) ──────────────────────────────────
// The PRICED lock card in the Files view: as Sales worker / as Production manager a priced document is in no group — never named,
// never previewed, never chosen, downloaded or attached — and ONE line counts them; the upload's tick "This file shows prices"
// (never to the floor); Mark as priced, and taking the mark off only for a price holder; the order's files count theirs too.
describe('F-CP-144: the PRICED lock card, the upload tick, Mark as priced', () => {
  const draw = (locale: 'it' | 'en', id: string) => {
    const item = designScreen.cases.find((one) => one.id === id)!
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(designScreen.view as ComponentType<{ model: unknown }>, { model: item.model })))
  }
  const locked = (n: number) => file({ id: `p${n}`, name: '', locked: 'PRICED' })

  it('a priced document locked for the reader is in no group, counted once, never chosen or downloaded', () => {
    const files = [locked(1), locked(2), file({ id: 'o', name: 'Size chart.xlsx' })]
    expect(filesGroups(files, RECORD).flatMap((group) => group.series.map((one) => one.latest.id))).toEqual(['o'])
    expect(pricedLockedIn(files, RECORD)).toBe(2)
    expect(bulkReach([locked(1)], PARTY, ALL)).toMatchObject({ download: [], share: [] })
    // Another record's priced file is not counted here (R-1 to R-4).
    expect(pricedLockedIn([file({ id: 'x', name: '', locked: 'PRICED', recordType: 'WorkOrder' })], RECORD)).toBe(0)
  })

  it('as Sales worker: one counted line and why, no name, no preview, in it and en; the others offer Mark as priced', () => {
    const en = draw('en', 'priced-locked')
    expect(en).toContain('2 priced documents — you cannot open them')
    expect(en).toContain('Only people who see prices open it.')
    expect(en).not.toContain('never drawn')
    expect(en).toContain('Mark as priced')
    expect(en).not.toContain('Take the price mark off')
    expect(draw('it', 'priced-locked')).toContain('2 documenti con prezzi — non puoi aprirli')
    // Every file of the record priced: the counted line, never "No files yet".
    const only = draw('en', 'priced-only')
    expect(only).toContain('2 priced documents — you cannot open them')
    expect(only).not.toContain('No files yet')
  })

  it('as a price holder: the priced PO said so, Take the price mark off', () => {
    const html = draw('en', 'priced-holder')
    expect(html).toContain('Brand Alpha PO 4471.pdf')
    expect(html).toContain('Priced document: only people who see prices open it.')
    expect(html).toContain('Take the price mark off')
  })

  it('the upload asks "This file shows prices"; a priced file never goes to the floor (Add held with why)', () => {
    expect(uploadPricedHeld({ priced: true, audience: 'FLOOR' })).toBe('priced.floor')
    expect(uploadPricedHeld({ priced: true, audience: 'OFFICE' })).toBeNull()
    expect(uploadPricedHeld({ priced: false, audience: 'FLOOR' })).toBeNull()
    // The upload window is a DS Modal (mocked to draw in place here).
    const html = draw('en', 'upload-priced')
    expect(html).toContain('This file shows prices')
    expect(html).toContain('A priced document is never shared with a floor: the floor sees no prices.')
    // The container sends the tick with the upload.
    const docked = readFileSync(new URL('../../../areas/_shared/record-thread/DockedOfficeThread.tsx', import.meta.url), 'utf8')
    expect(docked).toContain('...(ask.priced ? { priced: true } : {})')
    expect(docked).toContain('setFilePriced(api, fileId, { priced, version: file.version })')
  })

  it('the order\'s files: the priced documents left out are counted on one line and in their group, never named', () => {
    const read: OrderFilesRead = {
      order: { id: 'so-alpha', number: 'SO-2026-0142' },
      groups: [
        { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [], leftOut: 0, measurementsLeftOut: 0, pricedLeftOut: 2 },
        { key: 'RETURNS', words: { en: 'Returns & complaints', it: 'Resi e reclami' }, files: [], leftOut: 0, measurementsLeftOut: 0 },
      ],
      total: 0,
      truncated: false,
    }
    expect(orderPricedLeftOut(read)).toBe(2)
    expect(orderGroupsShown(read).map((group) => group.key)).toEqual(['ORDER'])
    for (const locale of LOCALES) {
      const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(OrderFilesBody, { model: { read, problem: null, selected: [], canShare: false }, party: null })))
      expect(html).toContain(locale === 'en' ? '2 priced documents — you cannot open them' : '2 documenti con prezzi — non puoi aprirli')
    }
  })
})
// ── end F-CP-144 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
