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
