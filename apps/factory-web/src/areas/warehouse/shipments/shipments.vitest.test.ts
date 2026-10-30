import { createElement } from 'react'
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
} from './model'
import { designScreen as recordScreen } from './record/fixtures'
import { ShipmentRecordView } from './record/view/ShipmentRecordView'

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
})
