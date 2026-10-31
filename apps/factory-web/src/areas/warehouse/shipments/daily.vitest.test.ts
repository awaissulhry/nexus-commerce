import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LOCALES } from '../../../lib/i18n/locales'
import { CATALOGUE, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { backorder, canOf, DDT_LIVE, documents, evidence, freight, labelled, OPEN_ROWS, PACKING_LISTS, pricedFor, row, rowsFor, shipment, trackingLabelled } from './_demo/fixtures'
import {
  backorderSummary,
  evidenceEnough,
  evidenceHelds,
  evidenceMissing,
  evidenceNeed,
  freightFacts,
  freightHeld,
  packDocuments,
  packingListToPrint,
  paperProblem,
  parseFreight,
  printDdtsHeld,
  printDdtsPlan,
  progressRows,
  voidHeld,
  voidOutcomeKey,
  voidPlan,
} from './daily-model'
import { abilitiesOf, rowsQuery, shipmentsCsv, tabOf } from './model'
import { designScreen as packScreen } from './pack/fixtures'
import { ShipmentPackView } from './pack/view/ShipmentPackView'

const FINANCE = abilitiesOf(['shipping.view', 'shipping.freight.manage', 'shipping.evidence.manage', 'files.upload', 'files.read', 'money.price', 'invoices.view'])
const WAREHOUSE = canOf('warehouse')

describe('the freight charged (LOG-105): a price, by the rule or typed', () => {
  it('is drawn only with the price grain; not decided before the goods leave; why the rule gives it', () => {
    const left = labelled('SHIPPED')
    expect(freightFacts(left.freight, left, FINANCE)).toMatchObject({ shown: true, charge: 1400, byRule: 1400, state: 'byRule', basis: { key: 'charge.basis.PER_PARCEL', params: { parcels: 2 } } })
    const packed = shipment('PACKED')
    expect(freightFacts(packed.freight, packed, FINANCE)).toMatchObject({ charge: null, state: 'open' })
    // Without the grain the API sends no amount: never drawn as 0, and the state still reads from the status.
    const hidden = pricedFor(left, 'warehouse')
    expect(hidden.freight).not.toHaveProperty('charge')
    expect(freightFacts(hidden.freight, hidden, WAREHOUSE)).toMatchObject({ shown: false, charge: null, byRule: null, state: 'byRule' })
    expect(freightFacts(freight(900, { byHand: true }), left, FINANCE).state).toBe('byHand')
  })

  it('takes either language\'s amounts, 0 included; held without the right, the grain, or once cancelled', () => {
    expect(parseFreight('12,50')).toBe(1250)
    expect(parseFreight('1.250,5')).toBe(125050)
    expect(parseFreight('€ 0')).toBe(0)
    expect(parseFreight('')).toBeNull()
    expect(parseFreight('12,5,0')).toBeUndefined()
    expect(parseFreight('dodici')).toBeUndefined()
    expect(parseFreight('-3')).toBeUndefined()
    expect(freightHeld(shipment('PACKED'), FINANCE)).toBeNull()
    expect(freightHeld(shipment('PACKED'), WAREHOUSE)).toEqual({ key: 'held.noFreight' })
    expect(freightHeld(shipment('PACKED'), abilitiesOf(['shipping.freight.manage']))).toEqual({ key: 'held.noPrice' })
    expect(freightHeld(shipment('CANCELLED'), FINANCE)).toEqual({ key: 'held.freightCancelled' })
  })

  it('the list column and the CSV carry it only with the grain', () => {
    expect(rowsFor([row(8, 'SHIPPED')], 'warehouse')[0]).not.toHaveProperty('freightCharge')
    const csv = shipmentsCsv([row(8, 'SHIPPED')], { header: (column) => column, status: (status) => status, carrier: () => 'BRT' }, { price: true })
    expect(csv.split('\n')[0]!.endsWith(',freight,currency')).toBe(true)
    expect(csv.split('\n')[1]!.endsWith(',14.00,EUR')).toBe(true)
  })
})

describe('Void labels (LOG-028, pop:sh-void)', () => {
  const ready = labelled('PACKED')
  it('voids every labelled parcel the carrier does not have yet; held with its reason', () => {
    const plan = voidPlan(ready, trackingLabelled(ready))
    expect(plan.toVoid.map((parcel) => parcel.seq)).toEqual([1, 2])
    expect(voidHeld(ready, plan, WAREHOUSE)).toBeNull()
    const collected = voidPlan(ready, trackingLabelled(ready, [2]))
    expect(collected).toMatchObject({ kept: [{ seq: 2, status: 'IN_TRANSIT' }] })
    expect(collected.toVoid.map((parcel) => parcel.seq)).toEqual([1])
    expect(voidHeld(ready, voidPlan(ready, trackingLabelled(ready, [1, 2])), WAREHOUSE)).toEqual({ key: 'held.voidCollected', params: { count: 2 } })
    expect(voidHeld(ready, plan, canOf('sales'))).toEqual({ key: 'held.noVoid' })
    expect(voidHeld(labelled('SHIPPED'), plan, WAREHOUSE)).toEqual({ key: 'held.voidLeft' })
    expect(voidHeld(shipment('PACKED'), voidPlan(shipment('PACKED'), null), WAREHOUSE)).toEqual({ key: 'held.noLabels' })
    expect(voidOutcomeKey({ ok: true, carrier: 'QUEUED' })).toBe('void.outcome.QUEUED')
    expect(voidOutcomeKey({ ok: false, carrier: null })).toBe('void.outcome.kept')
  })
})

describe('the order on this shipment and the backorder (LOG-004)', () => {
  it('a size grid per order line; "on other shipments" only when there is one', () => {
    const line = backorder('partial').lines[0]!
    expect(progressRows(line).map((entry) => [entry.measure, entry.values, entry.total])).toEqual([
      ['ordered', [4, 6, 3], 13],
      ['released', [4, 6, 2], 12],
      ['shippedBefore', [1, 2, 0], 3],
      ['thisShipment', [2, 4, 2], 8],
      ['left', [1, 0, 1], 2],
    ])
  })

  it('says what stays behind, or that this shipment completes the order', () => {
    expect(backorderSummary(backorder('partial'))).toEqual({ key: 'backorder.partialBoth', params: { count: 2, ready: 1, making: 1 } })
    expect(backorderSummary(backorder('complete'))).toMatchObject({ key: 'backorder.complete' })
    expect(backorderSummary(backorder('closed'))).toMatchObject({ key: 'backorder.completeShort', params: { closed: 2 } })
  })
})

describe('Print N DDTs (the selection row)', () => {
  it('prints the live DDTs, skips the rest and names them; needs the packing right', () => {
    const plan = printDdtsPlan([OPEN_ROWS[1]!, OPEN_ROWS[3]!, OPEN_ROWS[5]!])
    expect(plan.printable.map((entry) => entry.number)).toEqual([OPEN_ROWS[3]!.number, OPEN_ROWS[5]!.number])
    expect(plan.skipped.map((entry) => entry.number)).toEqual([OPEN_ROWS[1]!.number])
    expect(printDdtsHeld(plan, WAREHOUSE)).toBeNull()
    expect(printDdtsHeld(plan, canOf('sales'))).toEqual({ key: 'held.noPrintDdt' })
    expect(printDdtsHeld(printDdtsPlan([OPEN_ROWS[0]!]), WAREHOUSE)).toEqual({ key: 'held.noDdtSelected' })
  })
})

describe('the driver\'s pack and the packing list\'s versions', () => {
  it('prints the current packing list, else the newest; the DDT, the packing list, each style\'s DoC and user information', () => {
    expect(packingListToPrint(PACKING_LISTS)?.number).toBe('SH-00160/2')
    expect(packingListToPrint([{ ...PACKING_LISTS[1]! }])?.number).toBe('SH-00160/1')
    expect(packingListToPrint([])).toBeNull()
    const pack = packDocuments({ ddt: { number: DDT_LIVE.number, fileId: DDT_LIVE.fileId }, ddtRequired: true, packingList: PACKING_LISTS[0]!, travel: documents('attached').documents })
    expect(pack.map((entry) => entry.kind)).toEqual(['DDT', 'PACKING_LIST', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'])
    expect(pack.every((entry) => entry.fileId !== null && entry.missing === null)).toBe(true)
    const none = packDocuments({ ddt: null, ddtRequired: true, packingList: null, travel: documents('missing').documents })
    expect(none.map((entry) => entry.missing?.key)).toEqual(['pack.missing.ddt', 'pack.missing.packingList', 'pack.missing.travel', 'pack.missing.travel'])
  })

  it('is a built page of its own (a new tab of the shipment)', () => {
    expect(OFFICE_PAGES.has('/warehouse/shipments/[id]/pack')).toBe(true)
  })
})

describe('the intra-EU transport evidence (LOG-090)', () => {
  const left = labelled('DELIVERED')
  it('enough = two papers, one a transport document; what is missing in words', () => {
    expect(evidenceEnough(evidence('PARTIAL').papers)).toBe(false)
    expect(evidenceEnough(evidence('COMPLETE').papers)).toBe(true)
    expect(evidenceEnough([{ ...evidence('PARTIAL').papers[0]!, kind: 'OTHER' }, { ...evidence('PARTIAL').papers[0]!, kind: 'OTHER', fileId: 'x' }])).toBe(false)
    expect(evidenceMissing(evidence('AWAITED'))).toEqual({ key: 'evidence.missing.none' })
    expect(evidenceMissing(evidence('PARTIAL'))).toEqual({ key: 'evidence.missing.second', params: { count: 1 } })
    expect(evidenceMissing(evidence('PARTIAL', { papers: evidence('COMPLETE').papers }))).toEqual({ key: 'evidence.missing.check' })
    expect(evidenceMissing(evidence('COMPLETE'))).toBeNull()
  })

  it('why it is needed, in words: a zero-rated EU sale, Italy, decided when the goods leave', () => {
    const germany = { ...left, shipTo: { ...left.shipTo, country: 'DE' } }
    expect(evidenceNeed(evidence('AWAITED'), germany)).toEqual({ key: 'evidence.need.sale', params: { country: 'DE' } })
    expect(evidenceNeed(evidence('NOT_NEEDED'), left)).toEqual({ key: 'evidence.need.italy', params: { country: 'IT' } })
    expect(evidenceNeed(evidence('NOT_NEEDED', { neededBySale: true }), { ...germany, status: 'PACKED' })).toMatchObject({ key: 'evidence.need.whenLeaves' })
  })

  it('each action held with its reason', () => {
    expect(evidenceHelds(evidence('AWAITED'), left, WAREHOUSE)).toEqual({ file: null, complete: { key: 'held.evidenceShort' }, reopen: { key: 'held.evidenceOpen' }, need: null })
    expect(evidenceHelds(evidence('COMPLETE'), left, FINANCE)).toMatchObject({ complete: { key: 'held.evidenceComplete' }, reopen: null, need: { key: 'held.evidenceReopenFirst' } })
    expect(evidenceHelds(evidence('PARTIAL'), left, FINANCE).need).toEqual({ key: 'held.evidencePapers', params: { count: 1 } })
    expect(evidenceHelds(evidence('NOT_NEEDED'), shipment('PACKED'), FINANCE)).toMatchObject({ file: { key: 'held.evidenceNotLeft' }, need: { key: 'held.evidenceNotLeft' } })
    expect(evidenceHelds(evidence('AWAITED'), left, canOf('sales')).file).toEqual({ key: 'held.noEvidence' })
    expect(evidenceHelds(evidence('AWAITED'), left, abilitiesOf(['shipping.evidence.manage'])).file).toEqual({ key: 'held.noUpload' })
  })

  it('a paper is a PDF or a photo up to 25 MB', () => {
    expect(paperProblem({ type: 'application/pdf', size: 1000, name: 'pod.pdf' })).toBeNull()
    expect(paperProblem({ type: '', size: 1000, name: 'CMR.JPG' })).toBeNull()
    expect(paperProblem({ type: 'text/html', size: 1000, name: 'x.html' })).toBe('evidence.file.type')
    expect(paperProblem({ type: 'application/pdf', size: 30 * 1_048_576, name: 'big.pdf' })).toBe('evidence.file.size')
    expect(paperProblem({ type: 'application/pdf', size: 0, name: 'empty.pdf' })).toBe('evidence.file.empty')
  })

  it('the list follows it (?rows=evidence → evidence=open); the record has Export and Invoice tabs', () => {
    expect(rowsQuery('evidence', '')).toMatchObject({ evidence: 'open' })
    expect(tabOf('export')).toBe('export')
    expect(tabOf('invoice')).toBe('invoice')
  })
})

// ---- the driver's pack drawn in it and en: no key left on screen ---------------------------------------------------------------

const TOP = [...new Set(Object.keys(CATALOGUE.en.shipments ?? {}).map((key) => key.split('.')[0]!))]
const LEFT_KEY = new RegExp(`(?:^|[\\s>"(])(?:${TOP.join('|')})\\.[a-zA-Z]+(?:\\.[a-zA-Z_]+)*`)

describe('SCR-067-pack draws every design case in both languages', () => {
  for (const locale of LOCALES) {
    it(`${packScreen.cases.length} cases in ${locale}: no key left`, () => {
      for (const item of packScreen.cases) {
        const html = renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shipments', 'lists', 'records', 'shell']) }, createElement(ShipmentPackView, { model: item.model.page })))
        expect(html.length, item.id).toBeGreaterThan(200)
        expect(html.match(LEFT_KEY)?.[0] ?? null, `${item.id} (${locale})`).toBeNull()
      }
    })
  }
})
