import { describe, expect, it } from 'vitest'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { readScan } from '../../scan/scan-model'
import type { PackLine, PackParcel, Packing, PackingRow } from './api'
import { batchesOf, carrierOf, documentsState, headOf, readyRows, scanTarget, unpackHeld, weightText } from './model'

/** The packing bench's rules (SCR-098): figures worked out by hand. Scan into the carton's own: carton/carton.vitest.test.ts. */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const SERIAL = formatScanId({ type: 'SERIAL', tenantTag: TAG, ref: 4242 })

let n = 0
const line = (size: string, quantity: number, parcelId: string | null, extra: Partial<PackLine> = {}): PackLine => ({
  id: `l${++n}`,
  version: 1,
  parcelId,
  workOrderId: 'wo1',
  workOrderNumber: 'WO-0042',
  batchNumber: 'BT-41',
  workOrderSizeId: `c-${size}`,
  styleCode: 'GIA',
  styleName: 'Giacca',
  colourwayCode: 'NERO',
  colourwayName: 'Nero',
  size,
  quantity,
  serialTracked: false,
  serials: [],
  ...extra,
})
const parcel = (seq: number, extra: Partial<PackParcel> = {}): PackParcel => ({ id: `p${seq}`, version: 1, seq, grossWeightKg: null, lengthCm: null, widthCm: null, heightCm: null, trackingNumber: null, labelledAt: null, garments: 0, ...extra })
const row = (number: string, status: PackingRow['status'] = 'DRAFT', createdAt = '2026-10-29T08:00:00Z'): PackingRow => ({ id: number.toLowerCase(), number, status, version: 1, siteId: 's', transportBy: 'CARRIER', carrierCode: 'brt', lines: 1, garments: 1, parcels: 0, packedAt: null, createdAt })

describe('a weight as the API takes it', () => {
  it('rounds to two decimals above 0', () => {
    expect([weightText(4.256), weightText(0), weightText(-1), weightText(Number.NaN), weightText(12)]).toEqual(['4.26', null, null, null, '12'])
  })
})

describe('what a scanned code is', () => {
  const rows = [row('SH-0012'), row('SH-0013')]
  it('a pack slip opens its shipment, in any case and with spaces; so do its cartons\' marks', () => {
    expect(scanTarget(readScan(' sh-0012 ', TAG), false, rows)).toEqual({ kind: 'shipment', row: rows[0], carton: null })
    expect(scanTarget(readScan('SH-0013-2', TAG), false, rows)).toEqual({ kind: 'shipment', row: rows[1], carton: 2 })
    expect(scanTarget(readScan('SH-0013-0', TAG), false, rows).kind).toBe('unknown')
    expect(scanTarget(readScan('SH-0099', TAG), false, rows).kind).toBe('unknown')
  })
  it('with a shipment open any other code of this factory is a garment for the office to read; another factory\'s is not', () => {
    expect(scanTarget(readScan('bt-41', TAG), true, rows)).toEqual({ kind: 'garment', code: 'bt-41' })
    expect(scanTarget(readScan(SERIAL, TAG), true, rows)).toEqual({ kind: 'garment', code: SERIAL })
    const other = formatScanId({ type: 'SERIAL', tenantTag: tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b11'), ref: 1 })
    expect(scanTarget(readScan(other, TAG), true, rows).kind).toBe('unknown')
  })
})

describe('after packing: what the station prints, and why a part waits', () => {
  const packing = (extra: Partial<Packing> = {}): Pick<Packing, 'transportBy' | 'documents' | 'settings'> => ({
    transportBy: 'CARRIER',
    documents: { ddt: { id: 'd', number: 'DDT-1', documentDate: '2026-10-29', fileId: 'f' }, packingList: null },
    settings: { cutOffTime: null, labelPrinterId: 'lp', documentPrinterId: 'dp' },
    ...extra,
  })
  const labels = (toLabel: number, printer: string | null = 'lp') => ({ labelPrinterId: printer, toLabel, parcels: [{ parcelId: 'p1', seq: 1, trackingNumber: toLabel > 0 ? null : 'T1', labelledAt: null, print: null }] })
  it('everything ready prints with one tap', () => {
    expect(documentsState(packing(), labels(0), { printLabels: true })).toMatchObject({ labels: { held: null, labelled: 1, total: 1 }, documents: { held: null, ddtNumber: 'DDT-1' }, printable: true })
  })
  it('the office issues the DDT and buys the labels; a station without its printers; a role without label printing', () => {
    expect(documentsState(packing({ documents: { ddt: null, packingList: null } }), labels(1), { printLabels: true })).toMatchObject({ labels: { held: 'officeBuys' }, documents: { held: 'officeIssues' }, printable: false })
    expect(documentsState(packing({ settings: { cutOffTime: null, labelPrinterId: null, documentPrinterId: null } }), labels(0, null), { printLabels: true })).toMatchObject({ labels: { held: 'noPrinter' }, documents: { held: 'noPrinter' } })
    expect(documentsState(packing(), labels(0), { printLabels: false }).labels.held).toBe('noRight')
    expect(documentsState(packing({ documents: { ddt: { id: 'd', number: 'DDT-1', documentDate: '2026-10-29', fileId: null }, packingList: null } }), labels(0), { printLabels: true }).documents.held).toBe('pdfMissing')
  })
  it('own van or the customer collecting: no carrier label', () => {
    expect(documentsState(packing({ transportBy: 'SENDER' }), null, { printLabels: true })).toMatchObject({ labels: { held: 'notNeeded' }, printable: true })
  })
  it('unpacking waits for a label or a live DDT', () => {
    expect(unpackHeld({ parcels: [parcel(1, { trackingNumber: 'T' })], documents: { ddt: null, packingList: null } })).toBe('labelled')
    expect(unpackHeld({ parcels: [parcel(1)], ...packing() })).toBe('ddt')
    expect(unpackHeld({ parcels: [parcel(1)], documents: { ddt: null, packingList: null } })).toBeNull()
  })
})

describe('the list and the shipment', () => {
  it('lists the shipments to pack first, oldest first, then the packed ones waiting for documents', () => {
    const rows = [row('SH-3', 'PACKED', '2026-10-29T07:00:00Z'), row('SH-2', 'DRAFT', '2026-10-29T09:00:00Z'), row('SH-1', 'DRAFT', '2026-10-29T08:00:00Z'), row('SH-4', 'SHIPPED')]
    expect(readyRows(rows).map((entry) => entry.number)).toEqual(['SH-1', 'SH-2', 'SH-3'])
  })
  it("the strip: number, state, the carrier as the floor reads it, the bench's cartons, the batches released", () => {
    const lines = [line('50', 2, 'p1'), line('52', 1, null, { batchNumber: 'BT-42' }), line('54', 1, null, { batchNumber: null })]
    const packing: Packing = { id: 's', number: 'SH-1', status: 'DRAFT', version: 1, siteId: 'x', transportBy: 'CARRIER', carrierCode: 'poste_italiane', serviceCode: null, packedAt: null, lines, parcels: [parcel(1)], garments: 4, documents: { ddt: null, packingList: null }, settings: null }
    expect(headOf(packing, 3)).toEqual({ id: 's', number: 'SH-1', status: 'DRAFT', carrier: 'POSTE ITALIANE', transportBy: 'CARRIER', cartons: 3, batches: ['BT-41', 'BT-42'] })
    expect(headOf(packing).cartons).toBe(1)
    expect([carrierOf(null), batchesOf([])]).toEqual([null, []])
  })
})
