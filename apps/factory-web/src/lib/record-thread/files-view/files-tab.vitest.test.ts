import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { formatDate } from '../../i18n/format'
import { LOCALES } from '../../i18n/locales'
import { createTranslator, messagesFor } from '../../i18n/messages'
import { render, textOf } from '../parts/testing'
import { filesAnswerOf, orderChoosableOf, orderCountedOf, orderGroupsShown, orderSectionsOf, orderShownFilesOf, tabAnswerOf, type OrderFile, type OrderFilesRead } from './model'
import { chipMarksOf, heldReasonKey } from './model' // F-OF-102
import { FilesView, OrderFilesBody } from './view/FilesView'
import type { ThreadFile } from '../files/model'
import { orderFileHrefOf } from '../../../areas/_shared/record-thread/order-file-href'

// The DS Modal opens only in a browser (after hydration, in a portal): here it draws in place, so a window's words are read.
vi.mock('@nexus/ui/components', async (original) => {
  const actual = await original<typeof import('@nexus/ui/components')>()
  const Modal = ({ open, title, subtitle, children, footer }: { open: boolean; title?: unknown; subtitle?: unknown; children?: unknown; footer?: unknown }) =>
    open ? createElement('section', { role: 'dialog' }, createElement('h2', null, title as never), createElement('p', null, subtitle as never), children as never, footer as never) : null
  return { ...actual, Modal }
})

/**
 * F-OF-101 (order FILES tab, 10-design §1–§5; 15-steps W1) — the shell: the groups as the tab draws them (Shipments and Invoices & credit
 * notes split by the file's source, one block per source with its door "Open on … ›", Production by work order, an annulled or replaced
 * paper folded with its words), the counted line said ONCE with its reasons (P0-B1, P0-B2), the tab's and the section's answers, the
 * tech pack's mark (F2-B1), and the walk in display order. Made-up data only (Seed Company A, SEED-SO-0002, WO-0041).
 */

const ORDER = { id: 'so-seed-0002', number: 'SEED-SO-0002' }
const file = (id: string, over: Partial<OrderFile> = {}): OrderFile => ({
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
const wo = { type: 'WorkOrder', id: 'wo-41', label: 'WO-0041' }
const hold = { type: 'WorkOrderHold', id: 'hold-1', label: 'WO-0041' }
const shipment = { type: 'Shipment', id: 'sh-11', label: 'SEED-SH-0011' }
const ddt = { type: 'Ddt', id: 'ddt-144', label: 'DDT 144/2026' }
const invoice = { type: 'Invoice', id: 'ft-41', label: 'FT-2026-00041' }
const READ: OrderFilesRead = {
  order: ORDER,
  groups: [
    { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [file('carton', { audience: 'CUSTOMER_CAN_SEE', at: '2026-11-14T10:00:00Z' })], leftOut: 0, measurementsLeftOut: 0, pricedLeftOut: 2 },
    { key: 'LINES', words: { en: 'Lines & artwork', it: 'Righe e grafiche' }, files: [file('logo', { from: { type: 'SalesOrderLine', id: 'l1', label: 'SEED-SO-0002 · 1' }, versionNo: 2, versions: 3 })], leftOut: 0, measurementsLeftOut: 1 },
    { key: 'TECH_PACK', words: { en: "Customer's tech pack", it: 'Scheda tecnica del cliente' }, files: [file('pack', { from: { type: 'SalesInquiry', id: 'inq-42', label: 'SEED-INQ-0042' }, versionNo: 3, techPack: { named: 2, newer: true } })], leftOut: 0, measurementsLeftOut: 0 },
    { key: 'REQUESTS', words: { en: 'Requests', it: 'Richieste' }, files: [file('sleeve', { from: { type: 'OrderChangeRequest', id: 'cr-3', label: 'SEED-SO-0002 · DESIGN' } })], leftOut: 0, measurementsLeftOut: 0 },
    { key: 'PRODUCTION', words: { en: 'Production', it: 'Produzione' }, files: [file('hold-photo', { kind: 'PHOTO', contentType: 'image/jpeg', from: hold }), file('cutting', { from: wo })], leftOut: 1, measurementsLeftOut: 0 },
    { key: 'QUALITY', words: { en: 'Quality', it: 'Qualità' }, files: [], leftOut: 0, measurementsLeftOut: 0 },
    {
      key: 'SHIPMENTS',
      words: { en: 'Shipments & invoices', it: 'Spedizioni e fatture' },
      files: [
        file('ddt-144', { from: ddt, fiscal: true, kept: { legalHold: false, retainUntil: '2036-12-31T00:00:00Z' } }),
        file('ddt-143', { from: { ...ddt, state: 'ANNULLED' } }),
        file('packing', { from: shipment }),
        file('xml-new', { from: invoice, contentType: 'application/xml' }),
        file('xml-old', { from: { ...invoice, state: 'REPLACED' }, contentType: 'application/xml' }),
      ],
      leftOut: 0,
      measurementsLeftOut: 0,
    },
    { key: 'RETURNS', words: { en: 'Returns & complaints', it: 'Resi e reclami' }, files: [], leftOut: 0, measurementsLeftOut: 0 },
  ],
  total: 10,
  truncated: false,
}

describe('F-OF-101: the groups as the tab draws them', () => {
  it('splits the read\'s Shipments & invoices by the file\'s source, keeps the read\'s order, leaves an empty group out', () => {
    const sections = orderSectionsOf(READ)
    expect(sections.map((section) => section.key)).toEqual(['ORDER', 'LINES', 'TECH_PACK', 'REQUESTS', 'PRODUCTION', 'SHIPMENTS', 'INVOICES'])
    // The web names the two halves; every other group keeps the read's words.
    expect(sections.find((section) => section.key === 'SHIPMENTS')?.words).toBeNull()
    expect(sections.find((section) => section.key === 'INVOICES')?.words).toBeNull()
    expect(sections[0]!.words).toEqual({ en: 'Order & thread', it: 'Ordine e conversazione' })
  })

  it('one block per source with its door; Production by work order (its hold under it, the door to the work order); a request opens on Changes', () => {
    const sections = orderSectionsOf(READ)
    const production = sections.find((section) => section.key === 'PRODUCTION')!
    expect(production.blocks).toHaveLength(1)
    expect(production.blocks[0]!.head).toEqual({ label: 'WO-0041', door: wo })
    expect(production.blocks[0]!.files.map((one) => one.id)).toEqual(['hold-photo', 'cutting'])
    const shipments = sections.find((section) => section.key === 'SHIPMENTS')!
    expect(shipments.blocks.map((block) => block.head?.label)).toEqual(['DDT 144/2026', 'SEED-SH-0011'])
    expect(sections.find((section) => section.key === 'REQUESTS')!.blocks[0]!.head).toEqual({ label: null, door: { type: 'OrderChangeRequest', id: 'cr-3', label: 'SEED-SO-0002 · DESIGN' } })
    // The order's own groups have no head and no door.
    expect(sections[0]!.blocks[0]!.head).toBeNull()
    expect(sections[1]!.blocks[0]!.head).toBeNull()
  })

  it('an annulled DDT and a replaced invoice file fold under their block; they are walked after the papers in force, never chosen', () => {
    const sections = orderSectionsOf(READ)
    const ddtBlock = sections.find((section) => section.key === 'SHIPMENTS')!.blocks[0]!
    expect(ddtBlock.files.map((one) => one.id)).toEqual(['ddt-144'])
    expect(ddtBlock.older.map((one) => one.id)).toEqual(['ddt-143'])
    expect(sections.find((section) => section.key === 'INVOICES')!.blocks[0]!.older.map((one) => one.id)).toEqual(['xml-old'])
    expect(orderShownFilesOf(sections).map((one) => one.id)).toEqual(['carton', 'logo', 'pack', 'sleeve', 'hold-photo', 'cutting', 'ddt-144', 'ddt-143', 'packing', 'xml-new', 'xml-old'])
    expect(orderChoosableOf(sections).map((one) => one.id)).not.toContain('ddt-143')
    // A folded paper is not counted in its group's number.
    expect(sections.find((section) => section.key === 'SHIPMENTS')!.count).toBe(2)
  })

  it('the customer\'s face: the same groups without a head or a door (no office words)', () => {
    const sections = orderSectionsOf(READ, 'customer')
    expect(sections.flatMap((section) => section.blocks.map((block) => block.head))).toEqual(sections.flatMap((section) => section.blocks.map(() => null)))
  })
})

describe('F-OF-101: the counted line and the answers', () => {
  it('P0-B1 / P0-B2: what the reader may not open is counted ONCE with the reasons; a group with only those is not drawn', () => {
    const sections = orderSectionsOf(READ)
    expect(orderCountedOf(READ, sections)).toEqual({ locked: 4, priced: 2, sheets: 1, role: 1, checking: 0 })
    const lockedOnly: OrderFilesRead = { ...READ, groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [], leftOut: 0, measurementsLeftOut: 0, pricedLeftOut: 2 }], total: 0 }
    expect(orderGroupsShown(lockedOnly)).toEqual([])
    expect(orderSectionsOf(lockedOnly)).toEqual([])
  })

  it('the section\'s answer in the reader\'s numbers; the tab\'s answer from the read\'s total', () => {
    expect(filesAnswerOf(orderSectionsOf(READ))).toEqual({ count: 9, shared: 1, newest: '2026-11-14T10:00:00Z' })
    expect(tabAnswerOf(READ, { locked: 4 })).toEqual({ parts: [{ key: 'tab.files', params: { count: 10 } }], tone: 'info' })
    const none: OrderFilesRead = { ...READ, groups: [], total: 0 }
    expect(tabAnswerOf(none, { locked: 0 }).parts).toEqual([{ key: 'tab.none' }])
    expect(tabAnswerOf(none, { locked: 2 }).parts).toEqual([{ key: 'tab.noneOpen' }])
  })
})

describe('F-OF-101: the body drawn — groups that flow, blocks with doors, folds, the counted line, the tech pack\'s mark', () => {
  const draw = (locale: 'it' | 'en', place: 'tab' | 'window' = 'tab') =>
    render(createElement(OrderFilesBody, { model: { read: READ, problem: null, selected: [], canShare: true }, party: { name: 'Seed Customer One' }, place, actions: { orderHrefOf: (record) => orderFileHrefOf(record, { prefix: '/w/SEED', id: ORDER.id, companyId: 'company-a' }) } }), locale)

  it('in both languages, with no key on screen', () => {
    for (const locale of LOCALES) {
      const html = draw(locale)
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      for (const words of [t('order.group.SHIPMENTS'), t('order.group.INVOICES'), t('order.openOn', { record: 'WO-0041' }), t('order.openOn', { record: 'SEED-SH-0011' }), t('order.openOnChanges'), t('order.older.show', { count: 1 }), t('order.techPack.named', { n: 2 }), t('order.techPack.newer'), t('counted.priced', { count: 2 }), t('counted.sheets', { count: 1 }), t('counted.role', { count: 1 }), t('order.leftOut', { count: 4 }), t('keep.until', { date: formatDate('2036-12-31T00:00:00Z', { locale }) }), t('version.earlier', { count: 2 })]) {
        expect(textOf(html), `${locale}: ${words}`).toContain(words)
      }
      expect(textOf(html)).not.toMatch(/\b(order|counted|answer|tab|held|group)\.[a-zA-Z]/)
      // The read's "Shipments & invoices" is never drawn: the web splits it.
      expect(textOf(html)).not.toContain(locale === 'en' ? 'Shipments & invoices' : 'Spedizioni e fatture')
    }
  })

  it('P0-B1: no "+ N you cannot open" under a group; a folded paper is not drawn until asked', () => {
    const html = draw('en')
    expect(html).not.toContain('you cannot open</p>')
    expect(html).not.toContain('data-card-id="ddt-143"')
    expect(html).toContain('aria-expanded="false"')
  })

  it('the doors are real links to the source\'s own page; a change request\'s to this order\'s Changes tab; the order\'s own files have none', () => {
    const html = draw('en')
    expect(html).toContain('href="/w/SEED/production/work-orders/wo-41')
    expect(html).toContain(`href="/w/SEED/sales/orders/${ORDER.id}?tab=changes"`)
    expect(orderFileHrefOf({ type: 'SalesOrder', id: ORDER.id, label: ORDER.number }, { prefix: '/w/SEED', id: ORDER.id, companyId: null })).toBeNull()
    expect(orderFileHrefOf({ type: 'SalesOrderLine', id: 'l1', label: 'line 1' }, { prefix: '/w/SEED', id: ORDER.id, companyId: null })).toBeNull()
  })

  it('one anchor per group on the tab (#files-SHIPMENTS …), none in the thread\'s window; the groups flow (their widest block sets their basis)', () => {
    const tab = draw('en')
    for (const key of ['ORDER', 'LINES', 'TECH_PACK', 'REQUESTS', 'PRODUCTION', 'SHIPMENTS', 'INVOICES']) expect(tab, key).toContain(`id="files-${key}"`)
    expect(draw('en', 'window')).not.toContain('id="files-')
    expect(tab).toContain('class="fw-of-groups"')
    expect(tab).toMatch(/--fw-of-n:\s*2/)
  })

  it('the card: the name opens the ONE viewer through one button (the preview clicks it); plain text, not a link\'s blue', () => {
    const html = draw('en')
    expect(html).toContain('class="fw-rtv-card-open" data-row="carton"')
    const css = readFileSync(new URL('./view/files-tab.css', import.meta.url), 'utf8')
    expect(css).toContain('.fw-of-body .fw-rtv-card-name { color: var(--nds-text); }')
    expect(css).toContain('@container fc (min-width: 300px)')
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })
})

describe('F-OF-101: the tab\'s layout — the Production kit in place, one answer, the Files section with its ⋯ and ONE ⓘ', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
  it('FilesTab draws the kit\'s Section in place (Kit.tsx untouched), its root the kit\'s size container; the keys only in the ⓘ', () => {
    const tab = source('../../../areas/sales/orders/record/view/FilesTab.tsx')
    expect(tab).toContain("import { InfoTip, Section } from './production/Kit'")
    expect(tab).toContain('<div className="fw-pt fw-of">')
    expect(tab).toContain('<OrderFilesBody model={files}')
    expect(tab).toContain("t('info.keys')")
    expect(source('../../../areas/sales/orders/record/view/production/Kit.tsx')).toContain('id: SectionId | ChangesSectionId /* F-OC-101 */ | MoneySectionId /* F-OM-101 */')
    // The keys left the body's foot (P0-B15): the tab's ⓘ says them; the thread's window keeps its own footer.
    expect(source('./view/FilesView.tsx')).not.toContain("place === 'tab' && (\n        <div className=\"fw-rtv-foot\">")
  })
  it('the doors\' addresses come from the page and the dock, through the container', () => {
    expect(source('../../../areas/sales/orders/record/OrderRecord.tsx')).toContain('hrefOf: (record) => (readyId ? orderFileHrefOf(record, { prefix, id: readyId')
    expect(source('../../../areas/_shared/record-thread/DockedOfficeThread.tsx')).toContain("hrefOf: (record) => orderFileHrefOf(record, { prefix: companyPrefix(session.company?.code ?? ''), id: key.id, companyId: host.record.companyId }), // F-OF-101")
    const container = source('../../../areas/_shared/record-thread/use-order-files.ts')
    expect(container).toContain('const listed = useMemo(() => (read ? orderShownFilesOf(orderSectionsOf(read)) : null), [read])')
    expect(container).toContain('...(input.hrefOf ? { orderHrefOf: input.hrefOf } : {}), // F-OF-101')
  })
})

// ---- F-OF-102 (order FILES tab, W1): the TRUE chip, the held files, the small bugs (P0-B3/B4/B5, F6-B5) -------------------------
describe('F-OF-102: the true chip — Office only · Customer · Floor · Link, one word per meaning', () => {
  it('the read\'s audiences when it says them; else the two-state audience of today', () => {
    expect(chipMarksOf({ audience: 'OFFICE_ONLY' })).toEqual(['office'])
    expect(chipMarksOf({ audience: 'CUSTOMER_CAN_SEE' })).toEqual(['customer'])
    // F6-B2: a floor or link file is no longer "Office only"; F4-B4: an invoice the customer reads says Customer.
    expect(chipMarksOf({ audience: 'OFFICE_ONLY', audiences: ['FLOOR'] })).toEqual(['floor'])
    expect(chipMarksOf({ audience: 'OFFICE_ONLY', audiences: ['LINK', 'CUSTOMER'] })).toEqual(['customer', 'link'])
    expect(chipMarksOf({ audience: 'CUSTOMER_CAN_SEE', audiences: [] })).toEqual(['office'])
  })

  it('drawn in the dock\'s words, in both languages', () => {
    const read: OrderFilesRead = { ...READ, groups: [{ key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [file('floor', { audiences: ['FLOOR'] }), file('link', { audiences: ['LINK'] })], leftOut: 0, measurementsLeftOut: 0 }], total: 2 }
    for (const locale of LOCALES) {
      const f = createTranslator(locale, messagesFor(locale, ['record-thread-files'])['record-thread-files']!)
      const text = textOf(render(createElement(OrderFilesBody, { model: { read, problem: null, selected: [], canShare: true }, party: null }), locale))
      expect(text).toContain(f('audience.floor'))
      expect(text).toContain(f('audience.link'))
      expect(text).not.toContain(f('audience.office'))
    }
  })
})

describe('F-OF-102: files held by the virus scan — the reader\'s own as a card, everyone else\'s counted', () => {
  const held: OrderFilesRead = {
    ...READ,
    groups: [
      { key: 'ORDER', words: { en: 'Order & thread', it: 'Ordine e conversazione' }, files: [file('carton')], leftOut: 0, measurementsLeftOut: 0 },
      { key: 'LINES', words: { en: 'Lines & artwork', it: 'Righe e grafiche' }, files: [], leftOut: 0, measurementsLeftOut: 0, heldCount: 2 },
      { key: 'PRODUCTION', words: { en: 'Production', it: 'Produzione' }, files: [], leftOut: 0, measurementsLeftOut: 0, heldCount: 1 },
    ],
    held: [{ id: 'h1', name: 'SEED-JKT-02 pattern size 52.pdf', group: 'LINES', at: '2026-11-22T09:31:00Z', reason: 'SCAN_PENDING' }],
    total: 1,
  }

  it('a group with only held files is drawn; the reader\'s own is a card, the others are counted in its head and on the counted line', () => {
    const sections = orderSectionsOf(held)
    expect(sections.map((section) => [section.key, section.held.map((one) => one.id), section.checking])).toEqual([
      ['ORDER', [], 0],
      ['LINES', ['h1'], 1],
      ['PRODUCTION', [], 1],
    ])
    expect(orderCountedOf(held, sections).checking).toBe(2)
    expect(tabAnswerOf(held, { locked: 0 })).toEqual({ parts: [{ key: 'tab.files', params: { count: 1 } }, { key: 'held.checking', params: { count: 3 } }], tone: 'warning' })
    expect([heldReasonKey({ reason: 'SCAN_PENDING' }), heldReasonKey({ reason: 'INFECTED' }), heldReasonKey({ reason: 'SCAN_FAILED' })]).toEqual(['keep.scanPending', 'keep.infected', 'keep.held'])
  })

  it('the held card: its name, "added by you" and why — no open, no download, no box, never previewed', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      const html = render(createElement(OrderFilesBody, { model: { read: held, problem: null, selected: [], canShare: true }, party: null }), locale)
      const card = html.slice(html.indexOf('data-held-id="h1"'), html.indexOf('</li>', html.indexOf('data-held-id="h1"')))
      for (const words of ['SEED-JKT-02 pattern size 52.pdf', t('card.addedByYou'), t('keep.scanPending'), t('card.checking')]) expect(textOf(card), `${locale}: ${words}`).toContain(words)
      for (const never of ['data-row', 'type="checkbox"', 'data-card-id', t('card.download')]) expect(card, never).not.toContain(never)
      expect(textOf(html)).toContain(t('group.checking', { count: 1 }))
      expect(textOf(html)).toContain(t('held.checking', { count: 2 }))
    }
  })
})

describe('F-OF-102: the small bugs — "1 file", one Clear, Share hidden without the right', () => {
  const chosenOwn = (canShare: boolean, locale: 'it' | 'en' = 'en', place: 'tab' | 'window' = 'tab') => render(createElement(OrderFilesBody, { model: { read: READ, problem: null, selected: ['carton'], canShare }, party: { name: 'Seed Customer One' }, place }), locale)

  it('P0-B4: "1 file chosen" (the bar\'s noun follows the count); P0-B5: ONE Clear, in the reader\'s words', () => {
    for (const locale of LOCALES) {
      const t = createTranslator(locale, messagesFor(locale, ['record-thread-files-view'])['record-thread-files-view']!)
      const html = chosenOwn(true, locale, 'window')
      expect(textOf(html)).toContain(`1 ${t('bulk.chosen', { count: 1 })}`)
      expect(html.split(`>${t('bulk.clear')}<`).length - 1).toBe(1)
      // The DS bar's own English "Clear" is not drawn (the body gives none to it); the window's box says "Choose all", never "… chosen: clear".
      if (locale === 'it') expect(html).not.toContain('>Clear<')
      expect(textOf(html)).toContain(t('select.all', { count: 9 }))
    }
  })

  it('F6-B5 / P0-B3: "Share N own" is hidden without the right; with it, held with words when nothing chosen is the order\'s own office-only file', () => {
    expect(chosenOwn(false)).not.toContain('own with Seed Customer One')
    expect(chosenOwn(true)).toContain('Share 0 own with Seed Customer One')
    const office = { ...READ, groups: [{ ...READ.groups[0]!, files: [file('carton')] }] }
    expect(render(createElement(OrderFilesBody, { model: { read: office, problem: null, selected: ['carton'], canShare: true }, party: { name: 'Seed Customer One' } }))).toContain('Share 1 own with Seed Customer One')
  })

  it('the Files window on any record: "1 file"; Share, Make office only and Delete hidden without their right (F6-B5)', () => {
    const one: ThreadFile = { id: 'f1', recordType: 'Quote', recordId: 'q1', name: 'Spec.pdf', contentType: 'application/pdf', kind: 'DOCUMENT', sizeBytes: 10, status: 'AVAILABLE', quarantineReason: null, visibility: ['OFFICE'], partyId: null, createdAt: '2026-11-10T09:00:00.000Z', previewUrl: null }
    const draw = (can: { upload: boolean; share: boolean; delete: boolean }) =>
      textOf(render(createElement(FilesView, { model: { record: { type: 'Quote', id: 'q1', label: 'SEED-QT-0007' }, party: { id: 'party-1', role: 'customer', name: 'Seed Customer One' }, files: [one], problem: null, can, uploadHeld: null, selected: ['f1'], refused: [], missing: [], upload: null, now: Date.parse('2026-11-22T10:00:00Z') } })))
    const none = draw({ upload: false, share: false, delete: false })
    expect(none).toContain('1 file')
    for (const hidden of ['Share with Seed Customer One', 'Make office only', 'Delete 1']) expect(none, hidden).not.toContain(hidden)
    const all = draw({ upload: true, share: true, delete: true })
    for (const shown of ['Share with Seed Customer One (1)', 'Delete 1']) expect(all, shown).toContain(shown)
  })
})
