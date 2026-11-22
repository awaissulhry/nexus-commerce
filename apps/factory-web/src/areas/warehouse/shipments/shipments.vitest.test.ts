import { readFileSync } from 'node:fs'
import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../lib/api/errors'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { listAddress as webListAddress, recordAddress } from '../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { DDT_ROW, documents, draftLoose, labelled, labels, OPEN_ROWS, ownVan, PREVIEW_HELD, PREVIEW_OK, READY, row, shipment } from './_demo/fixtures'
// F-OP-132 (order page N6): a shipment of two orders.
import { backorder, SECOND_ORDER, SECOND_READY, secondBackorder, sharedShipment } from './_demo/fixtures'
// F-OP-130 (order page N6): the record of a shared shipment.
import { CANDIDATES_AFTER } from './_demo/fixtures' // B-OP-047: the candidates as the read answers them now
import { joinHeld } from './model'
// F-OP-121: New shipment's ship-together helpers.
import { ordersOfNew, togetherRows } from './model'
import { leftKeys } from '../../../lib/record-thread/parts/testing'
// F-OP-131 (order page N6): the driver's pack.
import { designScreen as packScreen } from './pack/fixtures'
import { joinableShipmentsSchema, orderCandidatesSchema, readyOrderSchema, shipmentRowSchema, shipmentSchema } from './api'
import { lineGroups, lineOrderIds, orderNumbers, orderWords, rowOrders, shipmentOrders } from './model'
import { queueRowSchema, searchRowSchema } from './queue/api'
import { designScreen as listScreen } from './list/fixtures'
import { ShipmentsListView } from './list/view/ShipmentsListView'
import {
  abilitiesOf,
  annulPhrase,
  cutOffCards,
  ddtFormFor,
  ddtRequestOf,
  liveTouches,
  listAddress,
  newShipmentLines,
  newShipmentProblems,
  nextStep,
  readyChecks,
  rowsFromAddress,
  rowsQuery,
  shipmentsCsv,
  tileCounts,
  writeProblem,
  zonedInstant,
  // B-TH-264
  isWideTab,
  MERGED_TABS,
  RECORD_TABS,
  tabOf,
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { ShipmentRecordView } from './record/view/ShipmentRecordView'
// B-TH-264: the shipment on RecordFrame.
import { renderView, textOf } from '../../../lib/record-thread/parts/testing'
// B-TH-264 follow-up: the Documents' files in the thread's viewer.
import { travelFiles } from './record/view/DocumentsTab'

const WAREHOUSE = abilitiesOf(['shipping.view', 'shipping.manage', 'shipping.pack', 'shipping.ddt.issue', 'shipping.ddt.cancel', 'shipping.labels.buy', 'print.labels', 'files.read', 'shipping.settings.view'])
const VIEWER = abilitiesOf(['shipping.view'])

describe('the saved rows ⇄ the address ⇄ the API query (SCR-066)', () => {
  it('opens on the ship-today queue (what has not left yet); a state; all', () => {
    expect(rowsFromAddress(new URLSearchParams(''))).toBe('today')
    expect(rowsFromAddress(new URLSearchParams('rows=SHIPPED'))).toBe('SHIPPED')
    expect(rowsFromAddress(new URLSearchParams('rows=nonsense'))).toBe('today')
    expect(rowsQuery('today', 'brt')).toMatchObject({ open: true, q: 'brt', limit: 50 })
    expect(rowsQuery('DELIVERED', '')).toMatchObject({ status: 'DELIVERED' })
    expect(rowsQuery('all', '')).not.toHaveProperty('status')
    expect(listAddress('/w/A/warehouse/shipments', { rows: 'today', q: '', carrier: 'gls' })).toBe('/w/A/warehouse/shipments?carrier=gls')
    // A carrier filter belongs to today's queue only.
    expect(listAddress('/w/A/warehouse/shipments', { rows: 'all', q: ' SH ', carrier: 'gls' })).toBe('/w/A/warehouse/shipments?rows=all&q=SH')
  })

  it('a shipment opens on its own page, the API list on the Shipments page', () => {
    expect(recordAddress({ type: 'Shipment', id: 'abc' }, OFFICE_PAGES)).toBe('/warehouse/shipments/abc')
    expect(webListAddress('/shipping/shipments', { rows: 'SHIPPED' }, OFFICE_PAGES)).toBe('/warehouse/shipments?rows=SHIPPED')
  })
})

describe('the tiles and the carrier cut-off cards of the ship-today queue', () => {
  it('counts what to pack, to label, to hand over; unknown (null) when the queue was not read whole', () => {
    expect(tileCounts(OPEN_ROWS, false, 2)).toEqual({ toPack: 2, toLabel: 1, notHandedOver: 2, inTransit: 2 })
    expect(tileCounts(OPEN_ROWS, true, null)).toEqual({ toPack: null, toLabel: null, notHandedOver: null, inTransit: null })
  })

  it('a card per carrier (own van its own), what is ready and still to pack, the earliest cut-off of their sites', () => {
    const cards = cutOffCards(OPEN_ROWS, new Map([[OPEN_ROWS[0]!.siteId, '17:00']]), '2026-10-29')
    expect(cards.map((card) => card.key)).toEqual(['brt', 'gls', 'SENDER'])
    const brt = cards.find((card) => card.key === 'brt')!
    expect(brt).toMatchObject({ shipments: 3, toPack: 2, garmentsToPack: 12, parcelsReady: 2, cutOff: { time: '17:00', at: '2026-10-29T16:00:00.000Z' } })
    expect(cutOffCards(OPEN_ROWS, new Map(), '2026-10-29').every((card) => card.cutOff === null)).toBe(true)
  })

  it('a wall-clock time in Rome is its UTC instant, also across the clock change', () => {
    expect(zonedInstant('2026-10-29', '17:00')).toBe('2026-10-29T16:00:00.000Z')
    expect(zonedInstant('2026-07-01', '17:00')).toBe('2026-07-01T15:00:00.000Z')
    expect(zonedInstant('2026-10-25', '09:00')).toBe('2026-10-25T08:00:00.000Z')
    expect(zonedInstant('2026-10-29', '25:00')).toBeNull()
  })
})

describe("a shipment's next step: Mark packed → Issue DDT → Buy labels → Mark handed over", () => {
  const facts = (value = shipment('PACKED'), over: Partial<Parameters<typeof nextStep>[0]> = {}) => ({ shipment: value, ddt: null, labels: labels(value), documents: documents('onFile'), ...over })

  it('holds each step with its reason, never the next one before its own', () => {
    expect(nextStep(facts(draftLoose()), WAREHOUSE)).toEqual({ kind: 'pack', held: { key: 'held.packing', params: { count: 3 } } })
    expect(nextStep(facts(shipment('DRAFT', { parcels: shipment('PACKED').parcels, lines: shipment('PACKED').lines })), WAREHOUSE)).toEqual({ kind: 'pack', held: null })
    expect(nextStep(facts(), WAREHOUSE)).toEqual({ kind: 'issueDdt', held: null })
    expect(nextStep(facts(), VIEWER)).toEqual({ kind: 'issueDdt', held: { key: 'held.noIssue' } })
    expect(nextStep(facts(shipment('PACKED'), { ddt: DDT_ROW }), WAREHOUSE)).toEqual({ kind: 'buyLabels', held: null })
    const ready = labelled('PACKED')
    expect(nextStep(facts(ready, { ddt: DDT_ROW, labels: labels(ready) }), WAREHOUSE)).toEqual({ kind: 'handOver', held: null })
    expect(nextStep(facts(ready, { ddt: DDT_ROW, labels: labels(ready), documents: documents('missing') }), WAREHOUSE)).toEqual({ kind: 'handOver', held: { key: 'held.documents', params: { count: 2 } } })
    // Own van: no label to buy.
    expect(nextStep(facts(ownVan(), { ddt: DDT_ROW, labels: labels(ownVan()) }), WAREHOUSE)).toEqual({ kind: 'handOver', held: null })
    expect(nextStep(facts(labelled('SHIPPED'), { ddt: DDT_ROW }), WAREHOUSE)).toEqual({ kind: null, held: null })
  })

  it('"Ready to ship" names every check with the tab that fixes it', () => {
    const checks = readyChecks({ shipment: shipment('PACKED'), ddt: null, labels: labels(shipment('PACKED')), documents: documents('missing') })
    expect(checks.map((check) => [check.code, check.state, check.tab])).toEqual([
      ['released', 'ok', 'lines'],
      ['documents', 'open', 'documents'],
      ['packed', 'ok', 'lines'],
      ['ddt', 'open', 'documents'],
      ['labels', 'open', 'carrier'],
    ])
    const own = readyChecks({ shipment: ownVan(), ddt: DDT_ROW, labels: null, documents: documents('fallback') })
    expect(own.find((check) => check.code === 'labels')).toMatchObject({ state: 'notNeeded' })
    expect(own.find((check) => check.code === 'documents')).toMatchObject({ state: 'warn' })
  })
})

describe('the DDT the office issues', () => {
  it('sends only what was typed; the goods leave in the same command only without a carrier', () => {
    const form = { ...ddtFormFor(shipment('PACKED'), PREVIEW_OK), netWeightKg: '9,8', remarks: ' Fragile ', ship: true }
    expect(ddtRequestOf(form, 'CARRIER', 5)).toEqual({ version: 5, reason: 'SALE', carrier: { name: 'BRT' }, appearance: 'Scatole di cartone', netWeightKg: '9.8', remarks: 'Fragile' })
    expect(ddtRequestOf({ ...form, carrierName: '' }, 'SENDER')).toMatchObject({ ship: true })
    expect(ddtRequestOf({ ...form, reason: 'OTHER', reasonText: 'Prova colore' }, 'SENDER')).toMatchObject({ reason: 'OTHER', reasonText: 'Prova colore' })
    expect(PREVIEW_HELD.problems.length).toBe(2)
    expect(annulPhrase({ number: '158/2026' })).toBe('158/2026')
  })
})

describe('New shipment: never more than a cell can still ship', () => {
  const cells = READY[0]!.cells
  it('takes 0 to the cap per size, and only the sizes asked', () => {
    expect(newShipmentProblems(cells, { [cells[0]!.workOrderSizeId]: 3 })).toEqual([])
    expect(newShipmentProblems(cells, { [cells[2]!.workOrderSizeId]: 4 })).toEqual([{ cellId: cells[2]!.workOrderSizeId, key: 'new.problem.range', params: { max: 2 } }])
    expect(newShipmentLines(cells, { [cells[0]!.workOrderSizeId]: 3, [cells[1]!.workOrderSizeId]: 0 })).toEqual([{ workOrderSizeId: cells[0]!.workOrderSizeId, quantity: 3 }])
  })
})

describe('problems in words, live events, the CSV', () => {
  it('a moved shipment reads again; a state refusal keeps the API sentence as its detail', () => {
    expect(writeProblem(new ApiError('conflict', 409, 'stale_version', 'Changed.', null, [{ path: 'body/version', message: 'stale' }]))).toMatchObject({ key: 'problem.write.moved', reload: true })
    expect(writeProblem(new ApiError('conflict', 409, 'invalid_state', 'Parcel 2 holds garments: move them first.'))).toMatchObject({ key: 'problem.write.state', detail: 'Parcel 2 holds garments: move them first.' })
  })

  it('the list hears shipment and DDT events; the record only the ones that name it', () => {
    expect(liveTouches({ type: 'shipment.packing_changed', fields: { shipmentId: 'x' } })).toBe(true)
    expect(liveTouches({ type: 'invoice.issued', fields: {} })).toBe(false)
    expect(liveTouches({ type: 'shipment.labels_bought', fields: { shipmentId: 'x' } }, new Set(['y']))).toBe(false)
    expect(liveTouches({ type: 'print.job_changed', fields: { recordId: 'y' } }, new Set(['y']))).toBe(true)
  })

  it('exports the selected rows with their DDT and tracking numbers', () => {
    const csv = shipmentsCsv([row(4, 'SHIPPED')], { header: (column) => column, status: (status) => status, carrier: (entry) => entry.carrierName ?? '' })
    expect(csv.split('\n')[1]).toBe('SH-00144,SHIPPED,Esempio Racing S.p.A.,SO-2026-0084,Bologna · IT,BRT,2,14.6000,154/2026,DEMO400451 DEMO400452,2026-10-28T16:05:00.000Z')
  })
})

// ---- every design case drawn in it and en: no key left on screen ---------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en.shipments ?? {}).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"(])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)
const NAMESPACES = ['shipments', 'lists', 'records', 'shell']

describe('SCR-066 and SCR-067 draw every design case in both languages', () => {
  for (const locale of LOCALES) {
    it(`${listScreen.cases.length} list cases and ${recordScreen.cases.length} record cases in ${locale}: no key left`, () => {
      const draw = (element: ReturnType<typeof createElement>) => renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, element))
      for (const item of listScreen.cases) {
        const html = draw(createElement(ShipmentsListView, { model: item.model.list }))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
      for (const item of recordScreen.cases) {
        const html = draw(createElement(ShipmentRecordView, { model: item.model.record }))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }

  it('an issued DDT is never offered for editing: it says it never changes (the dialogs are portals: the browser pass reads them)', () => {
    const draw = (id: string) => {
      const item = recordScreen.cases.find((entry) => entry.id === id)!
      return renderToString(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', NAMESPACES) }, createElement(ShipmentRecordView, { model: item.model.record })))
    }
    const issued = draw('issued')
    expect(issued).toContain('it never changes and its number is never used again')
    expect(issued).not.toMatch(/>Edit(?: DDT)?</)
    expect(draw('sales')).toContain('Read-only')
  })

  // B-W2b-F50: rule "TEST labels say TEST" (B-W2b-390, LOG-035).
  it('a TEST label says TEST and that it was not charged, never bought; a live label keeps its words', () => {
    const draw = (id: string, locale: 'it' | 'en') => {
      const item = recordScreen.cases.find((entry) => entry.id === id)!
      return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, NAMESPACES) }, createElement(ShipmentRecordView, { model: item.model.record })))
    }
    const test = draw('labels-test', 'en')
    expect(test).toContain('>TEST<')
    expect(test).toContain('Made ')
    expect(test).toContain('TEST labels: made by the test carrier, they go to no carrier and are not charged.')
    expect(test).not.toContain('Bought ')
    const testIt = draw('labels-test', 'it')
    expect(testIt).toContain('non sono addebitate')
    expect(testIt).not.toContain('Comprata il')
    // A live label keeps its words.
    expect(draw('labels', 'en')).toContain('Bought ')
    expect(draw('labels', 'en')).not.toContain('TEST labels')
    // In test mode the step and the booking say test, never buy.
    const buy = draw('buy-dialog-test', 'en')
    expect(buy).toContain('Make 2 test labels')
    expect(buy).toContain('Test mode: the test carrier makes the labels, marked TEST; nothing is bought or charged.')
    expect(buy).not.toContain('Buy 2 labels')
    expect(draw('buy-dialog', 'en')).toContain('Buy 2 labels')
  })
})

// ---- B-TH-264: the shipment on RecordFrame (the rule of picture 38; 08-tabs O-WH-SHP) ---------------------------------------------
describe('B-TH-264 — the shipment on RecordFrame: tabs 7 → 5, the docked thread of its own customer, Activity gone (R-ACT)', () => {
  const drawCase = (id: string, locale: 'it' | 'en' = 'en') => renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === id)!.model, locale)
  const dockOf = (html: string) => html.slice(html.indexOf('class="fw-rcf-dock"'))

  it('five tabs: Lines & cartons · Documents · Carrier & tracking · Export · Invoice; every old ?tab= keeps working (R-8)', () => {
    expect(RECORD_TABS).toEqual(['lines', 'documents', 'carrier', 'export', 'invoice'])
    expect(MERGED_TABS).toEqual({ tracking: 'carrier', activity: 'lines' })
    expect(tabOf('tracking')).toBe('carrier')
    expect(tabOf('carrier')).toBe('carrier')
    expect(tabOf('activity')).toBe('lines')
    for (const tab of RECORD_TABS) expect(tabOf(tab)).toBe(tab)
    expect(tabOf(null)).toBe('lines')
    expect(tabOf('nope')).toBe('lines')
    expect(isWideTab('lines')).toBe(true)
    expect(isWideTab('documents')).toBe(false)
    const text = textOf(drawCase('thread-docked'))
    for (const tab of ['Lines & cartons', 'Documents', 'Carrier & tracking', 'Export', 'Invoice']) expect(text).toContain(tab)
    expect(text).not.toMatch(/\bActivity\b/)
    expect(text).not.toContain('Carrier & label')
    expect(textOf(drawCase('thread-docked', 'it'))).toContain('Corriere e tracciamento')
  })

  it('Carrier & tracking keeps every action of both tabs: the booking and the labels, then the carrier’s events', () => {
    const text = textOf(drawCase('thread-carrier'))
    expect(text).toContain('Booking')
    expect(text).toContain('Tracking')
    const source = readFileSync(new URL('./record/view/ShipmentRecordView.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/model\.tab === 'carrier' && \(\s*<div className="fw-sh-stack">\s*<CarrierTab[\s\S]*?\/>\s*<TrackingTab/)
    expect(source).not.toMatch(/model\.tab === 'tracking'/)
  })

  it('ONE thread on the page: the docked thread, no record panels', () => {
    const html = drawCase('thread-docked')
    expect(html.match(/class="fw-rcf-dock"/g)?.length).toBe(1)
    expect(html.match(/class="fw-rt-column[ "]/g)?.length).toBe(1)
    expect(html).toContain('class="fw-rt-column is-docked"')
    expect(html).not.toContain('fw-rp-tabs')
  })

  it('R-ACT: the thread’s "⋯" is reachable on every tab (Activity’s tools moved there)', () => {
    for (const id of ['thread-lines', 'docs-draft', 'thread-carrier', 'export-awaited', 'invoice-rule']) expect(drawCase(id), id).toContain('aria-label="Thread tools"')
  })

  it('the brand wall: the thread names this shipment’s own customer only (Reply to it; no other customer)', () => {
    const own = shipment('PACKED').party.legalName
    const dock = textOf(dockOf(drawCase('thread-docked')))
    expect(dock).toContain(own)
    for (const other of ['Esempio Racing S.p.A.', 'Squadra Fittizia S.r.l.', 'Brand Beta']) expect(dock).not.toContain(other)
  })

  it('one notice in the body column, never above the thread', () => {
    const html = drawCase('notice')
    const dockAt = html.indexOf('class="fw-rcf-dock"')
    expect(html.indexOf('class="fw-rcf-notices"')).toBeGreaterThan(-1)
    expect(html.indexOf('class="fw-rcf-notices"')).toBeLessThan(dockAt)
    expect(dockOf(html)).not.toContain('fw-rcf-notices')
  })

  it('the page mounts the office thread docked with the shipment’s own customer; the area’s dock hook and its ?tab=activity push are gone', () => {
    const container = readFileSync(new URL('./record/ShipmentRecord.tsx', import.meta.url), 'utf8')
    expect(container).toMatch(/<OfficeRecordThread\s+docked/)
    expect(container).toContain('party={{ id: value.partyId, name: value.party.legalName }}')
    expect(container).toContain('partyRole="customer"')
    expect(container).not.toContain('useThreadDock')
    const hooks = readFileSync(new URL('./hooks.ts', import.meta.url), 'utf8')
    expect(hooks).not.toContain('export function useThreadDock')
    expect(hooks).not.toContain('?tab=activity')
  })
})

// ---- B-TH-264 follow-up (TH-6 part B): the Documents' files open in the docked thread's ONE file viewer ---------------------------
describe('B-TH-264 follow-up — the Documents’ files open in the thread’s file viewer (the frame’s door), not a new tab', () => {
  it('the travelling documents a card lists, as the viewer names them: the copy for the customer, else the file on record', () => {
    const label = (entry: { kind: string }) => entry.kind
    const attached = documents('attached').documents.filter((entry) => entry.kind === 'DECLARATION_OF_CONFORMITY' || entry.kind === 'USER_INFORMATION')
    expect(travelFiles(attached, label)).toEqual([
      expect.objectContaining({ name: 'declaration_of_conformity-copy.pdf', contentType: 'application/pdf', sizeBytes: 182_400 }),
      expect.objectContaining({ name: 'user_information-copy.pdf', contentType: 'application/pdf' }),
    ])
    const onFile = documents('onFile').documents.filter((entry) => entry.kind === 'DECLARATION_OF_CONFORMITY')
    expect(travelFiles(onFile, label)).toEqual([expect.objectContaining({ name: 'declaration_of_conformity.pdf' })])
    // Nothing on file: nothing to open.
    expect(travelFiles(documents('missing').documents, label)).toEqual([])
  })

  it('the DoC, the user information and the packing lists open through the frame’s door (the page’s own download only without a thread)', () => {
    const source = readFileSync(new URL('./record/view/DocumentsTab.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/if \(frame\?\.openFiles\) frame\.openFiles\(\{ files, fileId, returnTo: opener \?\? null \}\)\s*else actions\?\.onOpenFile\?\.\(fileId\)/)
    expect(source).toContain("openInViewer(files, (entry.copy ?? entry.source)!.id, event.currentTarget)")
    expect(source).toContain('openInViewer(files, entry.fileId, event.currentTarget)')
    expect(source).not.toContain('onClick={() => actions?.onOpenFile?.(')
  })

  it('their buttons say they open the viewer, in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale].shipments ?? {}
      expect(words['docs.travel.view'], locale).toBeTruthy()
      expect(words['other.view'], locale).toBeTruthy()
      expect(words['docs.travel.open'], locale).toBeUndefined()
      expect(words['other.download'], locale).toBeUndefined()
    }
    expect(textOf(renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === 'docs-fallback')!.model, 'en'))).toContain('Declaration of Conformity')
  })
})
// ---- end B-TH-264 follow-up

// ---- F-OP-132 (order page N6, R-5): the Warehouse api types know a shipment's several orders ------------------------------------
describe('F-OP-132 — a shipment of two orders of one customer: the answers parse, each line has its order', () => {
  const two = sharedShipment()
  const orderIds = two.salesOrders!.map((order) => order.id)

  it('the record, the list row, the queue row and the search row parse with every order, the first first', () => {
    const record = shipmentSchema.parse(two)
    expect(shipmentOrders(record).map((order) => order.number)).toEqual(['SO-2026-0088', 'SO-2026-0090'])
    expect(shipmentOrders(record)[0]!.id).toBe(record.salesOrderId)
    const listed = shipmentRowSchema.parse({ ...row(1, 'DRAFT'), salesOrders: [{ id: orderIds[0], number: 'SO-2026-0088', customerRef: 'PO-MD-7731' }, { id: orderIds[1], number: 'SO-2026-0090', customerRef: null }] })
    expect(orderNumbers(rowOrders(listed))).toBe('SO-2026-0088, SO-2026-0090')
    const orders = [{ id: orderIds[0], number: 'SO-2026-0088', customerRef: 'PO-MD-7731' }, { id: orderIds[1], number: 'SO-2026-0090', customerRef: 'PO-MD-7740' }]
    const queued = { id: two.id, number: two.number, status: 'DRAFT', siteId: two.siteId, salesOrderId: orderIds[0], salesOrderNumber: 'SO-2026-0088', customerRef: 'PO-MD-7731', salesOrders: orders, partyCode: 'C-DEMO-01', partyName: 'Moto Demo S.r.l.', carrierKey: 'brt', transportBy: 'CARRIER', carrierCode: 'brt', carrierName: 'BRT', serviceCode: null, shipTo: { city: 'Milano', country: 'IT' }, splitFromId: null, garments: 11, parcels: 2, labelled: 0, shipBy: null, cutOff: null, risk: 'NO_DATE', willMiss: false, held: false, holdReasons: [] }
    expect(rowOrders(queueRowSchema.parse(queued)).map((order) => order.customerRef)).toEqual(['PO-MD-7731', 'PO-MD-7740'])
    const found = { id: two.id, number: two.number, status: 'DRAFT', siteCode: 'A1', salesOrderId: orderIds[0], salesOrderNumber: 'SO-2026-0088', customerRef: 'PO-MD-7731', salesOrders: orders, partyName: 'Moto Demo S.r.l.', transportBy: 'CARRIER', carrierCode: 'brt', carrierName: 'BRT', serviceCode: null, trackingNumbers: [], parcels: 2, garments: 11, ddtNumber: null, splitFrom: null, holdReasons: [], createdAt: two.createdAt, shippedAt: null, deliveredAt: null, cancelledAt: null, matchedBy: ['ORDER'], matchedSerials: [] }
    // The search finds it through its second order (B-OP-041: the number or PO of any order it carries).
    expect(rowOrders(searchRowSchema.parse(found)).map((order) => order.number)).toEqual(['SO-2026-0088', 'SO-2026-0090'])
  })

  it('an older answer without the list is its first order alone (never empty, never another order)', () => {
    const one = shipment('DRAFT')
    expect(shipmentOrders(one)).toEqual([{ id: one.salesOrderId, number: 'SO-2026-0088', customerRef: 'PO-MD-7731' }])
    const plain = row(2, 'PACKED')
    expect(rowOrders(plain)).toEqual([{ id: plain.salesOrderId, number: plain.salesOrderNumber, customerRef: null }])
  })

  it('candidates, joinable shipments and ship together parse with their verdicts (the API words kept as they are)', () => {
    const candidates = orderCandidatesSchema.parse({ shipmentId: two.id, number: two.number, orders: [{ salesOrderId: orderIds[1], number: 'SO-2026-0090', customerRef: 'PO-MD-7740', status: 'READY', joinable: { allowed: false, why: 'SO-2026-0090 goes to Bologna, shipment SH-00160 to Milano: one shipment goes to one address.' } }] }) // B-OP-047: a reason that still exists
    expect(candidates.orders[0]!.joinable).toEqual({ allowed: false, why: 'SO-2026-0090 goes to Bologna, shipment SH-00160 to Milano: one shipment goes to one address.' })
    const joinable = joinableShipmentsSchema.parse({ salesOrderId: orderIds[1], number: 'SO-2026-0090', shipments: [{ shipmentId: two.id, number: two.number, status: 'DRAFT', siteId: two.siteId, joinable: { allowed: true, why: null } }] })
    expect(joinable.shipments[0]!.joinable.allowed).toBe(true)
    const together = readyOrderSchema.parse({ ...SECOND_READY, shipsWith: { allowed: false, why: 'SO-2026-0090 goes to Bologna, this shipment to Milano: one shipment goes to one address.' } })
    expect(together.shipsWith?.allowed).toBe(false)
    expect(readyOrderSchema.parse(READY[0]).shipsWith).toBeUndefined()
  })

  it('each line has its order: from each order’s lines (the backorder read); unread lines last; one order reads nothing', () => {
    const groups = lineGroups(two, [backorder(), secondBackorder()])
    expect(groups.map((group) => [group.order?.number ?? null, group.lines.map((entry) => entry.size)])).toEqual([
      ['SO-2026-0088', ['50', '52', '54']],
      ['SO-2026-0090', ['52']],
    ])
    // The second order's read is not there yet: its line waits in a group of its own (never put under the first order).
    expect(lineGroups(two, [backorder()]).map((group) => group.order?.number ?? null)).toEqual(['SO-2026-0088', null])
    expect(lineGroups(two, null).map((group) => group.order)).toEqual([null])
    // F-OP-121 (lead addition): the office's read names each line's order — grouped without the backorder read.
    const named = { ...two, lines: two.lines.map((line, index) => ({ ...line, salesOrderId: index < 3 ? two.salesOrderId : two.salesOrders![1]!.id })) }
    expect(lineGroups(named, null).map((group) => [group.order?.number ?? null, group.lines.map((entry) => entry.size)])).toEqual([
      ['SO-2026-0088', ['50', '52', '54']],
      ['SO-2026-0090', ['52']],
    ])
    expect(lineGroups(shipment('DRAFT'), null)).toEqual([{ order: shipmentOrders(shipment('DRAFT'))[0], lines: shipment('DRAFT').lines }])
    expect(lineOrderIds([secondBackorder()]).get(two.lines[3]!.salesOrderLineId)).toBe(SECOND_ORDER.id)
  })

  it('the order’s words: its number and its PO in the catalogue’s PO words', () => {
    expect(orderWords({ number: 'SO-2026-0090', customerRef: 'PO-MD-7740' }, (ref) => `Customer PO ${ref}`)).toBe('SO-2026-0090 · Customer PO PO-MD-7740')
    expect(orderWords({ number: 'SO-2026-0090', customerRef: null }, (ref) => ref)).toBe('SO-2026-0090')
  })
})
// ---- end F-OP-132

// ---- F-OP-130 (order page N6, R-5): the Warehouse shipment shows every order it carries -------------------------------------------
describe('F-OP-130 — the shipment record names every order, groups its lines by order and PO, and lets an order join or leave a DRAFT', () => {
  const drawCase = (id: string, locale: 'it' | 'en' = 'en') => textOf(renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === id)!.model, locale))
  const htmlOf = (id: string, locale: 'it' | 'en' = 'en') => renderView(recordScreen.view as ComponentType<{ model: unknown }>, recordScreen.cases.find((item) => item.id === id)!.model, locale)

  it('a shared DRAFT: a chip per order (each a link to it), its lines under each order and PO, Take its garments off for the second only', () => {
    const html = htmlOf('shared-draft')
    const text = textOf(html)
    expect(text).toContain('Order SO-2026-0088 · Customer PO PO-MD-7731')
    expect(text).toContain('Order SO-2026-0090 · Customer PO PO-MD-7740')
    expect(html).toContain(`/sales/orders/${SECOND_ORDER.id}?tab=shipments`)
    expect(text).toContain('SO-2026-0090 · Customer PO PO-MD-7740 3 garments in 1 lines')
    expect(text.match(/Take its garments off/g)?.length).toBe(1)
    expect(text).toContain("Add an order's garments…")
    // Each order's progress, titled by the order.
    expect(text).toContain('SO-2026-0088 · Customer PO PO-MD-7731 on this shipment')
    expect(text).toContain('SO-2026-0090 · Customer PO PO-MD-7740 on this shipment')
  })

  it('one order: the band, the lines and the progress as before (no order headings, nothing to take off)', () => {
    const text = drawCase('draft')
    expect(text).toContain('Order SO-2026-0088')
    expect(text).toContain('The order on this shipment')
    expect(text).not.toContain('Take its garments off')
    expect(text).not.toContain('on this shipment SO-')
    expect(text).toContain("Add an order's garments…")
  })

  it('whose each line is, while it is read: the lines wait in a group of their own, never under the wrong order, nothing to take off', () => {
    const text = drawCase('shared-reading')
    expect(text).toContain('Order not read yet')
    expect(text).not.toContain('Take its garments off')
  })

  it('read-only (Sales): every order named, no door to add or take off', () => {
    const text = drawCase('shared-packed')
    expect(text).toContain('Order SO-2026-0090 · Customer PO PO-MD-7740')
    expect(text).not.toContain("Add an order's garments…")
    expect(text).not.toContain('Take its garments off')
  })

  // F-OP-121 (lead addition): every reason in the screen's own words by its code (it + en), never the API's English sentence.
  it('an order that cannot join is held with why, every reason in the screen’s own words (B-OP-047: several orders are on)', () => {
    expect(joinHeld({ allowed: true, why: null })).toBeNull()
    expect(joinHeld(CANDIDATES_AFTER.orders[0]!.joinable)).toBeNull()
    expect(joinHeld(CANDIDATES_AFTER.orders[1]!.joinable)).toEqual({ key: 'shipOrders.why.SHIP_TO', detail: null })
    // An older answer without a code: "Cannot join this shipment", the sentence never on screen.
    expect(joinHeld({ allowed: false, why: 'SO-1 goes to Bologna.' })).toEqual({ key: 'shipOrders.cannotJoin', detail: null })
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['warehouse-shipments-depth'] ?? {}
      for (const code of ['CUSTOMER', 'COMPANY', 'SITE', 'SHIP_TO', 'CURRENCY', 'TAX_MODE', 'INCOTERM', 'BILL_TO_VAT', 'ORDER_STATE', 'SHIPMENT_STATE', 'CUSTOMER_HOLD']) expect(words[`shipOrders.why.${code}`], `${locale} ${code}`).toBeTruthy()
    }
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale]['warehouse-shipments-depth'] ?? {}
      for (const key of ['shipOrders.cannotJoin', 'shipOrders.add', 'shipOrders.takeOff', 'shipOrders.takeOffWhat_one', 'shipOrders.takeOffWhat_other', 'shipOrders.progressTitle', 'shipOrders.unread']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
    // B-OP-047: the held-off words are gone with the hold.
    for (const locale of LOCALES) expect(CATALOGUE[locale]['warehouse-shipments-depth']?.['shipOrders.later'], locale).toBeUndefined()
  })

  it('no shipOrders key is left on screen in any case, in either language', () => {
    for (const locale of LOCALES) for (const item of recordScreen.cases) expect(leftKeys(renderView(recordScreen.view as ComponentType<{ model: unknown }>, item.model, locale), ['shipOrders']), `${item.id} (${locale})`).toEqual([])
  })

  // F-OS-203 (B-OS-013, X1-B2): an order leaves in ONE command, all or nothing, with the office's reason (no line-by-line loop).
  it('the record reads what every order can still ship and each order’s lines; an order leaves in ONE command with its reason', () => {
    const source = readFileSync(new URL('./record/ShipmentRecord.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Promise.all(shipmentOrders(value).map((order) => readyToShip(api, { salesOrderId: order.id })')
    expect(source).toContain('Promise.all(shipmentOrders(value).map((order) => orderBackorder(api, order.id, value.id)))')
    expect(source).toContain('takeOffOrder(api, shipmentId, salesOrderId, version(), reason, key)')
    expect(source).not.toContain('for (const lineId of ids) next = await removeLine(')
    // Never the first order: the shipment was made for it.
    expect(source).toContain('salesOrderId === value.salesOrderId) return')
    expect(source).toContain('orderCandidates(api, value.id)')
  })

  it('the lists name every order: the CSV of the list and of the queue', () => {
    const shared = { ...row(3, 'PACKED'), salesOrders: [{ id: 'a', number: 'SO-2026-0083', customerRef: 'PO-1' }, { id: 'b', number: 'SO-2026-0090', customerRef: 'PO-2' }] }
    const csv = shipmentsCsv([shared], { header: (column) => column, status: (status) => status, carrier: () => 'BRT' })
    expect(csv).toContain('"SO-2026-0083, SO-2026-0090"')
    expect(shipmentsCsv([row(3, 'PACKED')], { header: (column) => column, status: (status) => status, carrier: () => 'BRT' })).toContain(',SO-2026-0083,')
  })
})
// ---- end F-OP-130

// ---- F-OP-131 (order page N6, R-5): the driver's pack names every order -------------------------------------------------------------
describe("F-OP-131 — the driver's sheet names each order the shipment carries, with its PO", () => {
  const drawPack = (id: string, locale: 'it' | 'en' = 'en') => textOf(renderView(packScreen.view as ComponentType<{ model: unknown }>, packScreen.cases.find((item) => item.id === id)!.model, locale))

  it('two orders: "Orders", each with its PO; one order: "Order" as before', () => {
    const shared = drawPack('shared')
    expect(shared).toContain('Orders SO-2026-0088 · Customer PO PO-MD-7731 SO-2026-0090 · Customer PO PO-MD-7740')
    expect(drawPack('shared', 'it')).toContain('Ordini SO-2026-0088 · Ordine cliente PO-MD-7731 SO-2026-0090 · Ordine cliente PO-MD-7740')
    const one = drawPack('ready')
    expect(one).toContain('Order SO-2026-0088 · Customer PO PO-MD-7731')
    expect(one).not.toContain('SO-2026-0090')
  })

  it('no key left on the sheet in any case', () => {
    for (const locale of LOCALES) for (const item of packScreen.cases) expect(leftKeys(renderView(packScreen.view as ComponentType<{ model: unknown }>, item.model, locale), ['shipOrders']), `${item.id} (${locale})`).toEqual([])
  })
})
// ---- end F-OP-131

// ── F-OP-121 (order page plan N6): New shipment from the order page — this order, the customer's others beside it ─────────────────
describe('F-OP-121: New shipment with the same customer’s other orders (ship together)', () => {
  const held = { ...SECOND_READY, salesOrderId: 'other-held', number: 'SO-2026-0095', shipsWith: { allowed: false, code: 'SITE' as const, why: 'SO-2026-0095 waits at another site.' } }
  const off = { ...SECOND_READY, salesOrderId: 'other-off', number: 'SO-2026-0096', shipsWith: { allowed: false, code: 'CUSTOMER_HOLD' as const, why: 'BRAND-ALPHA is on hold.' } } // B-OP-047
  const free = { ...SECOND_READY, salesOrderId: 'other-free', number: 'SO-2026-0097', shipsWith: { allowed: true, code: null, why: null } }
  const first = { ...SECOND_READY, salesOrderId: 'first', number: 'SO-2026-0090', shipsWith: null }
  const model = { orders: [first, held, off, free], salesOrderId: 'first', together: true, others: ['other-free'] }

  it('offers the other orders held with their reason (another site, a hold on the customer), never the order itself', () => {
    expect(togetherRows(model).map((row) => [row.order.salesOrderId, row.held?.key ?? null])).toEqual([
      ['other-held', 'shipOrders.why.SITE'],
      ['other-off', 'shipOrders.why.CUSTOMER_HOLD'],
      ['other-free', null],
    ])
    // Not from the order page: no other orders offered.
    expect(togetherRows({ ...model, together: false })).toEqual([])
  })

  it('the shipment carries this order first, then the others added (their cells are step 2’s)', () => {
    expect(ordersOfNew(model).map((order) => order.salesOrderId)).toEqual(['first', 'other-free'])
    expect(ordersOfNew({ ...model, others: [] }).map((order) => order.salesOrderId)).toEqual(['first'])
  })

  it('the words exist in both languages', () => {
    for (const locale of LOCALES) {
      const words = CATALOGUE[locale].shipments ?? {}
      for (const key of ['new.together.this_one', 'new.together.this_other', 'new.together.add', 'new.together.none']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
// ── end F-OP-121 ──
