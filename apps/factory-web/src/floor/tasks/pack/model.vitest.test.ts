import { describe, expect, it } from 'vitest'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { readScan } from '../../scan/scan-model'
import type { PackLine, PackParcel, Packing, PackingRow } from './api'
import { cartonsOf, cellsOf, currentCarton, documentsState, packingLeft, readyRows, scanTarget, serialRefusal, serialRefusalOfMessage, shipmentModel, sizeGrid, unpackHeld, weightText } from './model'

/** The packing bench's rules (SCR-098): figures worked out by hand. */

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

describe('cells, cartons and the size grid', () => {
  const lines = [line('50', 2, 'p1'), line('52', 3, 'p1'), line('52', 1, null), line('54', 2, null)]
  it('adds each cell\'s planned and packed garments and names the loose line', () => {
    const cells = cellsOf(lines)
    expect(cells.map((cell) => [cell.size, cell.planned, cell.packed, cell.loose])).toEqual([
      ['50', 2, 2, 0],
      ['52', 4, 3, 1],
      ['54', 2, 0, 2],
    ])
    expect(cells[1]!.looseLineId).toBe(lines[2]!.id)
    expect(sizeGrid(cells)).toEqual({ sizes: ['50', '52', '54'], rows: [{ key: 'GIA|NERO', label: 'GIA · NERO', sizes: [{ size: '50', planned: 2, packed: 2 }, { size: '52', planned: 4, packed: 3 }, { size: '54', planned: 2, packed: 0 }] }] })
  })

  it('says what each carton holds by colour and size', () => {
    const cartons = cartonsOf([parcel(2), parcel(1, { grossWeightKg: '4.2500' })], lines)
    expect(cartons.map((carton) => [carton.seq, carton.garments, carton.weightKg])).toEqual([
      [1, 5, '4.2500'],
      [2, 0, null],
    ])
    expect(cartons[0]!.contents).toEqual([
      { label: 'NERO 50', quantity: 2, serials: 0 },
      { label: 'NERO 52', quantity: 3, serials: 0 },
    ])
  })

  it('the current carton: the one picked, else the last open one, else none; never a labelled one', () => {
    const cartons = cartonsOf([parcel(1, { grossWeightKg: '4' }), parcel(2), parcel(3, { trackingNumber: 'T1', labelledAt: 'x' })], [])
    expect(currentCarton(cartons, null)?.seq).toBe(2)
    expect(currentCarton(cartons, 'p1')?.seq).toBe(1)
    expect(currentCarton(cartons, 'p3')?.seq).toBe(2)
    expect(currentCarton(cartonsOf([parcel(1, { grossWeightKg: '4' })], []), null)).toBeNull()
  })

  it('writes a weight as the API takes it', () => {
    expect(weightText(4.25)).toBe('4.25')
    expect(weightText(1.234)).toBe('1.23')
    expect(weightText(0.004)).toBeNull()
    expect(weightText(0)).toBeNull()
    expect(weightText(Number.NaN)).toBeNull()
  })
})

describe('what packing still needs (the API\'s guard, in codes)', () => {
  it('names loose garments, unweighed and empty cartons and missing serials; nothing left = Packing done', () => {
    const lines = [line('50', 2, 'p1'), line('52', 1, null), line('54', 2, 'p1', { serialTracked: true, serials: [{ id: 's', serial: 'x' }] })]
    const cartons = cartonsOf([parcel(1), parcel(2, { grossWeightKg: '1' })], lines)
    expect(packingLeft(lines, cartons)).toEqual([
      { kind: 'loose', count: 1 },
      { kind: 'unweighed', seqs: [1] },
      { kind: 'empty', seqs: [2] },
      { kind: 'serials', count: 1 },
    ])
    const done = [line('50', 2, 'p1')]
    expect(packingLeft(done, cartonsOf([parcel(1, { grossWeightKg: '3' })], done))).toEqual([])
    expect(packingLeft([], [])).toEqual([{ kind: 'noLines' }, { kind: 'noCartons' }])
  })
})

describe('what a scanned code is', () => {
  const packing = { lines: [line('50', 2, 'p1'), line('52', 1, null), line('54', 1, null, { serialTracked: true, batchNumber: 'BT-55', workOrderNumber: 'WO-0055', workOrderSizeId: 'c-s54' })] }
  const rows = [row('SH-0012')]
  it('a pack slip opens its shipment, in any case and with spaces', () => {
    expect(scanTarget(readScan(' sh-0012 ', TAG), null, rows)).toEqual({ kind: 'shipment', row: rows[0] })
    expect(scanTarget(readScan('SH-0099', TAG), null, rows).kind).toBe('unknown')
  })
  it('a batch label or its work order number names a cell with a garment left; a serial label goes to the lookup', () => {
    const garment = scanTarget(readScan('bt-41', TAG), packing, rows)
    expect(garment.kind === 'garment' && garment.cell.size).toBe('52')
    expect(scanTarget(readScan('WO-0042', TAG), packing, rows).kind).toBe('garment')
    expect(scanTarget(readScan('BT-55', TAG), packing, rows).kind).toBe('serialTracked')
    expect(scanTarget(readScan(SERIAL, TAG), packing, rows)).toEqual({ kind: 'serial', code: SERIAL })
    expect(scanTarget(readScan('XYZ', TAG), packing, rows).kind).toBe('unknown')
  })
  it('a batch whose garments are all in cartons says so', () => {
    expect(scanTarget(readScan('BT-41', TAG), { lines: [line('50', 2, 'p1')] }, rows)).toEqual({ kind: 'batchDone', code: 'BT-41' })
  })
})

describe('a scanned serial', () => {
  const lines = [line('50', 2, 'p1', { id: 'mine' })]
  it('is refused when quality has not released it, it is packed elsewhere or here already, void, shipped, or of no cell here', () => {
    expect(serialRefusal({ status: 'MADE', workOrderSizeId: 'c-50', shipmentLineId: null }, lines)).toBe('notReleased')
    expect(serialRefusal({ status: 'RELEASED', workOrderSizeId: 'c-50', shipmentLineId: 'other' }, lines)).toBe('otherShipment')
    expect(serialRefusal({ status: 'RELEASED', workOrderSizeId: 'c-50', shipmentLineId: 'mine' }, lines)).toBe('already')
    expect(serialRefusal({ status: 'VOID', workOrderSizeId: 'c-50', shipmentLineId: null }, lines)).toBe('void')
    expect(serialRefusal({ status: 'SHIPPED', workOrderSizeId: 'c-50', shipmentLineId: 'mine' }, lines)).toBe('shipped')
    expect(serialRefusal({ status: 'RELEASED', workOrderSizeId: 'c-99', shipmentLineId: null }, lines)).toBe('notThisShipment')
    expect(serialRefusal({ status: 'RELEASED', workOrderSizeId: 'c-50', shipmentLineId: null }, lines)).toBeNull()
  })
  it('reads the API\'s refusal back as the bench\'s code', () => {
    expect(serialRefusalOfMessage('Serial SN-1 is MADE: only garments quality released are packed (QHS-073).')).toBe('notReleased')
    expect(serialRefusalOfMessage('Serial SN-1 is packed in another shipment.')).toBe('otherShipment')
    expect(serialRefusalOfMessage("This shipment has no garment of serial SN-1's cell left without a serial in parcel 2.")).toBe('noRoom')
    expect(serialRefusalOfMessage('Something else')).toBeNull()
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
    expect(unpackHeld(cartonsOf([parcel(1, { trackingNumber: 'T' })], []), { documents: { ddt: null, packingList: null } })).toBe('labelled')
    expect(unpackHeld([], packing())).toBe('ddt')
    expect(unpackHeld([], { documents: { ddt: null, packingList: null } })).toBeNull()
  })
})

describe('the list and the shipment', () => {
  it('lists the shipments to pack first, oldest first, then the packed ones waiting for documents', () => {
    const rows = [row('SH-3', 'PACKED', '2026-10-29T07:00:00Z'), row('SH-2', 'DRAFT', '2026-10-29T09:00:00Z'), row('SH-1', 'DRAFT', '2026-10-29T08:00:00Z'), row('SH-4', 'SHIPPED')]
    expect(readyRows(rows).map((entry) => entry.number)).toEqual(['SH-1', 'SH-2', 'SH-3'])
  })
  it('a packed shipment has no current carton; packed counts the garments in cartons', () => {
    const lines = [line('50', 2, 'p1'), line('52', 1, null)]
    const base: Omit<Packing, 'status'> = { id: 's', number: 'SH-1', version: 1, siteId: 'x', transportBy: 'CARRIER', carrierCode: 'poste_italiane', serviceCode: null, packedAt: null, lines, parcels: [parcel(1)], garments: 3, documents: { ddt: null, packingList: null }, settings: null }
    const draft = shipmentModel({ ...base, status: 'DRAFT' }, null)
    expect([draft.packed, draft.garments, draft.current?.seq, draft.carrier]).toEqual([2, 3, 1, 'POSTE ITALIANE'])
    expect(shipmentModel({ ...base, status: 'PACKED' }, null).current).toBeNull()
  })
})
