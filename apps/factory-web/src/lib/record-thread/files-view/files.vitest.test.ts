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
