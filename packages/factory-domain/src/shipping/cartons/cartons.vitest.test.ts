import { describe, expect, it } from 'vitest'
import { cartonMarkCode, cartonMarks, DEFAULT_MARK_FIELDS, type MarkFacts } from './marks'
import { databasePackingRefusal } from './refusals'
import { benchProblems, cellsOfPiece, marksCurrent, openCarton, renumbered, sizeGrid, takeInto, takeOutOf, type CartonLine, type CartonParcel, type ScannedPiece } from './rules'

const line = (id: string, values: Partial<CartonLine> = {}): CartonLine => ({
  id,
  cellId: 'c52',
  workOrderId: 'wo1',
  styleId: 'jkt',
  styleCode: 'JKT-01',
  colourwayId: 'blk',
  colourwayCode: 'BLK',
  size: '52',
  quantity: 3,
  parcelId: null,
  scanned: 0,
  serialIds: [],
  serialsInCarton: 0,
  serialTracked: false,
  ...values,
})
const parcel = (id: string, seq: number, values: Partial<CartonParcel> = {}): CartonParcel => ({ id, seq, closed: false, labelled: false, ...values })
const sku = (values: Partial<Extract<ScannedPiece, { kind: 'SKU' }>> = {}): ScannedPiece => ({ kind: 'SKU', code: 'JKT-01-BLK-52', styleId: 'jkt', styleCode: 'JKT-01', colourwayId: 'blk', colourwayCode: 'BLK', size: '52', ...values })
const serial = (values: Partial<Extract<ScannedPiece, { kind: 'SERIAL' }>> = {}): ScannedPiece => ({
  kind: 'SERIAL',
  serialId: 'sn1',
  serial: 'SN-1',
  cellId: 'c52',
  styleId: 'jkt',
  styleCode: 'JKT-01',
  colourwayId: 'blk',
  colourwayCode: 'BLK',
  size: '52',
  status: 'RELEASED',
  forOrder: true,
  shipmentLineId: null,
  onThisShipment: false,
  parcelId: null,
  ...values,
})
const noSeq = () => null

describe('what a scanned garment is (LOG-007: refused in words on a wrong style, colour, size)', () => {
  const lines = [line('l1'), line('l2', { cellId: 'c50', size: '50' })]

  it('a SKU names the cells of its style, colour and size on the shipment', () => {
    expect(cellsOfPiece(sku(), lines, noSeq)).toEqual({ ok: true, cellIds: ['c52'] })
    expect(cellsOfPiece(sku({ styleId: 'pants', styleCode: 'PNT-02' }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'WRONG_STYLE', message: 'Style PNT-02 is not on this shipment.' } })
    expect(cellsOfPiece(sku({ colourwayId: 'red', colourwayCode: 'RED' }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'WRONG_COLOUR', message: 'JKT-01 in RED is not on this shipment.' } })
    expect(cellsOfPiece(sku({ size: '54' }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'WRONG_SIZE', message: 'JKT-01 BLK size 54 is not on this shipment.' } })
  })

  it('a serial-tracked style is scanned by its serial (PPE traceability: the serial goes into its carton)', () => {
    const tracked = lines.map((entry) => ({ ...entry, serialTracked: true }))
    expect(cellsOfPiece(sku(), tracked, noSeq)).toMatchObject({ ok: false, refusal: { code: 'SERIAL_NEEDED' } })
    expect(cellsOfPiece({ kind: 'BATCH', code: 'BT-1', workOrderId: 'wo1', cellId: null }, tracked, noSeq)).toMatchObject({ ok: false, refusal: { code: 'SERIAL_NEEDED' } })
    expect(cellsOfPiece(serial(), tracked, noSeq)).toEqual({ ok: true, cellIds: ['c52'] })
  })

  it('a serial: released, for an order, not packed elsewhere or already in a carton', () => {
    expect(cellsOfPiece(serial({ status: 'MADE' }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'NOT_RELEASED' } })
    expect(cellsOfPiece(serial({ forOrder: false }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'NOT_FOR_ORDER' } })
    expect(cellsOfPiece(serial({ shipmentLineId: 'other', onThisShipment: false }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'OTHER_SHIPMENT' } })
    expect(cellsOfPiece(serial({ shipmentLineId: 'l1', onThisShipment: true, parcelId: 'p1' }), lines, () => 2)).toMatchObject({ ok: false, refusal: { code: 'ALREADY_PACKED', message: 'Serial SN-1 is in carton 2 already.' } })
    expect(cellsOfPiece(serial({ cellId: 'c54', size: '54' }), lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'WRONG_SIZE' } })
  })

  it('a batch label names its one cell with garments left, or asks for the colour and size', () => {
    expect(cellsOfPiece({ kind: 'BATCH', code: 'BT-1', workOrderId: 'wo1', cellId: null }, lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'SIZE_NEEDED', message: 'Batch BT-1 has BLK 52, BLK 50 left on this shipment: choose the colour and size.' } })
    expect(cellsOfPiece({ kind: 'BATCH', code: 'BT-1', workOrderId: 'wo1', cellId: 'c50' }, lines, noSeq)).toEqual({ ok: true, cellIds: ['c50'] })
    expect(cellsOfPiece({ kind: 'BATCH', code: 'BT-1', workOrderId: 'wo1', cellId: null }, [line('l1'), line('l2', { cellId: 'c50', size: '50', scanned: 3, parcelId: 'p1' })], noSeq)).toEqual({ ok: true, cellIds: ['c52'] })
    expect(cellsOfPiece({ kind: 'BATCH', code: 'BT-9', workOrderId: 'wo9', cellId: null }, lines, noSeq)).toMatchObject({ ok: false, refusal: { code: 'WRONG_BATCH' } })
  })
})

describe('where the garment goes in the carton (LOG-007, LOG-010)', () => {
  it('counts it on the cell line in the carton while it has garments not scanned', () => {
    const lines = [line('l1', { parcelId: 'p1', scanned: 1 })]
    expect(takeInto(lines, ['c52'], [parcel('p1', 1)], 'p1', { serial: false, serialLineId: null })).toEqual({ ok: true, take: { kind: 'COUNT', lineId: 'l1' } })
  })

  it('else moves one garment from the loose line: a new line in the carton, onto its line there, or the whole line', () => {
    expect(takeInto([line('loose')], ['c52'], [parcel('p1', 1)], 'p1', { serial: false, serialLineId: null })).toEqual({ ok: true, take: { kind: 'MOVE', fromLineId: 'loose', intoLineId: null, whole: false } })
    expect(takeInto([line('loose'), line('in', { parcelId: 'p1', quantity: 2, scanned: 2 })], ['c52'], [parcel('p1', 1)], 'p1', { serial: false, serialLineId: null })).toEqual({ ok: true, take: { kind: 'MOVE', fromLineId: 'loose', intoLineId: 'in', whole: false } })
    expect(takeInto([line('loose', { quantity: 1 })], ['c52'], [parcel('p1', 1)], 'p1', { serial: false, serialLineId: null })).toEqual({ ok: true, take: { kind: 'MOVE', fromLineId: 'loose', intoLineId: null, whole: true } })
  })

  it('never takes a garment out of a closed or labelled carton; an extra piece is refused with the count', () => {
    const closed = [line('l1', { parcelId: 'p1', scanned: 2 })]
    expect(takeInto(closed, ['c52'], [parcel('p1', 1, { closed: true }), parcel('p2', 2)], 'p2', { serial: false, serialLineId: null })).toMatchObject({ ok: false, refusal: { code: 'EXTRA_PIECE' } })
    const full = [line('l1', { parcelId: 'p1', scanned: 3 })]
    expect(takeInto(full, ['c52'], [parcel('p1', 1)], 'p1', { serial: false, serialLineId: null })).toMatchObject({ ok: false, refusal: { code: 'EXTRA_PIECE', message: 'All 3 of JKT-01 BLK size 52 on this shipment are in cartons already: this one is an extra piece.' } })
  })

  it('a serial needs a garment without its serial; a serial already on a line of the shipment brings its garment', () => {
    const withSerials = [line('l1', { parcelId: 'p1', quantity: 2, scanned: 0, serialIds: ['a', 'b'] })]
    expect(takeInto(withSerials, ['c52'], [parcel('p1', 1)], 'p1', { serial: true, serialLineId: null })).toMatchObject({ ok: false, refusal: { code: 'EXTRA_PIECE' } })
    expect(takeInto(withSerials, ['c52'], [parcel('p1', 1)], 'p1', { serial: true, serialLineId: 'l1' })).toEqual({ ok: true, take: { kind: 'COUNT', lineId: 'l1' } })
    // A garment counted in the carton without its serial there: the serial takes the carton, the count stays.
    const countedWithout = [line('l1', { parcelId: 'p1', quantity: 1, scanned: 1, serialIds: ['a'], serialsInCarton: 0 })]
    expect(takeInto(countedWithout, ['c52'], [parcel('p1', 1)], 'p1', { serial: true, serialLineId: 'l1' })).toEqual({ ok: true, take: { kind: 'ATTACH', lineId: 'l1' } })
    expect(takeInto([line('l1', { parcelId: 'p1', quantity: 2, scanned: 1, serialIds: [] })], ['c52'], [parcel('p1', 1)], 'p1', { serial: true, serialLineId: null })).toEqual({ ok: true, take: { kind: 'ATTACH', lineId: 'l1' } })
    const loose = [line('loose', { quantity: 2, serialIds: ['a'] })]
    expect(takeInto(loose, ['c52'], [parcel('p1', 1)], 'p1', { serial: true, serialLineId: 'loose' })).toEqual({ ok: true, take: { kind: 'MOVE', fromLineId: 'loose', intoLineId: null, whole: false } })
  })

  it('takes a garment out of its carton back to the loose line (or as one), only when it is in that carton', () => {
    const lines = [line('in', { parcelId: 'p1', quantity: 2, scanned: 2 }), line('loose', { quantity: 1 })]
    expect(takeOutOf(lines, ['c52'], 'p1', { serialLineId: null, serialParcelId: null }, 'Code X')).toEqual({ ok: true, out: { lineId: 'in', intoLineId: 'loose', whole: false } })
    expect(takeOutOf([line('in', { parcelId: 'p1', quantity: 1, scanned: 1 })], ['c52'], 'p1', { serialLineId: null, serialParcelId: null }, 'Code X')).toEqual({ ok: true, out: { lineId: 'in', intoLineId: null, whole: true } })
    expect(takeOutOf(lines, ['c52'], 'p2', { serialLineId: null, serialParcelId: null }, 'Code X')).toMatchObject({ ok: false, refusal: { code: 'NOT_IN_CARTON', message: 'Code X is not in this carton.' } })
    expect(takeOutOf(lines, ['c52'], 'p1', { serialLineId: 'in', serialParcelId: 'p2' }, 'Serial SN-1')).toMatchObject({ ok: false, refusal: { code: 'NOT_IN_CARTON' } })
  })
})

describe('the size grid, the cartons and what packing still needs', () => {
  it('counts ordered against packed per style, colour and size', () => {
    const grid = sizeGrid([line('a', { parcelId: 'p1', quantity: 2, scanned: 2 }), line('b', { quantity: 1 }), line('c', { cellId: 'c50', size: '50', quantity: 2, scanned: 1, parcelId: 'p2' })])
    expect(grid).toEqual([{ styleId: 'jkt', colourwayId: 'blk', serialTracked: false, sizes: [{ size: '52', cellIds: ['c52'], ordered: 3, packed: 2 }, { size: '50', cellIds: ['c50'], ordered: 2, packed: 1 }] }])
  })

  it('numbers closed cartons "n of N" by place and count; their marks are current only when printed since', () => {
    const parcels = [
      { id: 'p1', seq: 1, cartonNumber: 1, cartonCount: 1, marksPrinted: true },
      { id: 'p2', seq: 2, cartonNumber: null, cartonCount: null, marksPrinted: false },
    ]
    expect(renumbered(parcels)).toEqual([{ id: 'p1', cartonNumber: 1, cartonCount: 2 }])
    expect(marksCurrent(parcels[0]!, 1)).toBe(true)
    expect(marksCurrent(parcels[0]!, 2)).toBe(false)
    expect(benchProblems([line('a', { parcelId: 'p2', scanned: 1, serialIds: ['s'] })], parcels.map((entry) => ({ ...entry, hasContents: true })))).toEqual(['NOT_SCANNED', 'SERIALS_NOT_IN_CARTONS', 'CARTON_OPEN', 'MARKS_NOT_PRINTED'])
  })

  it('a scan without a carton goes into the last open one without a label', () => {
    expect(openCarton([parcel('p1', 1), parcel('p2', 2), parcel('p3', 3, { closed: true })])?.id).toBe('p2')
    expect(openCarton([parcel('p1', 1, { labelled: true })])).toBeNull()
  })
})

describe("a carton's shipping marks (LOG-013)", () => {
  const facts: MarkFacts = {
    maker: 'Demo Pelle',
    sender: { name: 'Demo Pelle', line1: 'Via Uno 1', postalCode: '20100', city: 'Milano', country: 'IT' },
    shipTo: { name: 'Demo Brand GmbH', line1: 'Weg 2', postalCode: '10115', city: 'Berlin', country: 'DE' },
    customerOrder: 'PO-778',
    orderNumber: 'SO-0042',
    shipmentNumber: 'SH-00012',
    cartonNumber: 2,
    cartonCount: 3,
    contents: [
      { styleCode: 'JKT-01', styleName: 'Giacca', colourwayCode: 'BLK', colourwayName: 'Nero', size: '50', quantity: 2, batchNumber: 'BT-41', originCountry: 'IT' },
      { styleCode: 'JKT-01', styleName: 'Giacca', colourwayCode: 'BLK', colourwayName: 'Nero', size: '52', quantity: 3, batchNumber: 'BT-41', originCountry: 'IT' },
    ],
    grossWeightKg: '12.4000',
    netWeightKg: '11.6000',
    dimensionsCm: { length: '60.00', width: '40.00', height: '40.00' },
  }

  it('prints the template\'s fields in order and in its language, from codes', () => {
    const marks = cartonMarks(['CARTON_NUMBER', 'CUSTOMER_ORDER', 'SIZES', 'QUANTITY', 'GROSS_WEIGHT', 'SHIP_TO', 'ORIGIN', 'CUSTOMER_STYLE'], 'it', facts)
    expect(marks).toMatchObject({ language: 'it', heading: 'Collo · Demo Pelle', title: 'Collo 2 di 3', code: 'SH-00012-2' })
    expect(marks.rows).toEqual([
      { field: 'CARTON_NUMBER', label: 'Collo', lines: ['2 di 3'] },
      { field: 'CUSTOMER_ORDER', label: 'Vostro ordine', lines: ['PO-778'] },
      { field: 'SIZES', label: 'Taglie', lines: ['50 × 2 · 52 × 3'] },
      { field: 'QUANTITY', label: 'Quantità', lines: ['5 pezzi'] },
      { field: 'GROSS_WEIGHT', label: 'Peso lordo', lines: ['12,4 kg'] },
      { field: 'SHIP_TO', label: 'Destinatario', lines: ['Demo Brand GmbH', 'Weg 2', '10115 Berlin', 'Germania'] },
      // As recorded for customs, never a "Made in Italy" claim.
      { field: 'ORIGIN', label: 'Paese di origine', lines: ['Italia'] },
    ])
  })

  it('prints in English for any other language; a field with nothing to show is left out', () => {
    const marks = cartonMarks(DEFAULT_MARK_FIELDS, 'de', { ...facts, customerOrder: null })
    expect(marks.title).toBe('Carton 2 of 3')
    expect(marks.rows.map((row) => row.field)).toEqual(['SHIP_TO', 'CARTON_NUMBER', 'STYLE', 'COLOUR', 'SIZES', 'QUANTITY', 'BATCH'])
    expect(marks.rows.find((row) => row.field === 'BATCH')?.lines).toEqual(['BT-41'])
    expect(cartonMarkCode('SH 00012', 1)).toBe('SH00012-1')
  })
})

describe("the database's packing refusals in words (B-W2b-364's guards)", () => {
  it('words the ones a route can reach, and every other one in fixed words', () => {
    expect(databasePackingRefusal('packing: shipment x is PACKED with the contents of its cartons adding up to each line they hold (2 line(s) do not)')).toMatchObject({ path: 'packing/CONTENTS_DO_NOT_ADD_UP' })
    expect(databasePackingRefusal('packing: shipment x is PACKED with its numbered cartons each a different n, of N = its 3 carton(s) (reprint the marks)')).toMatchObject({ path: 'packing/MARKS_OUT_OF_DATE', message: 'The cartons\' marks do not say "n of 3" for each of the shipment\'s 3 carton(s): print the marks again.' })
    expect(databasePackingRefusal('packing: parcel x holds carton contents or packed serials; take them out first')).toMatchObject({ path: 'packing/PARCEL_HAS_CONTENTS' })
    expect(databasePackingRefusal('packing: shipment line x has carton contents; take them out first')).toMatchObject({ path: 'packing/LINE_HAS_CONTENTS' })
    expect(databasePackingRefusal("packing: shipment x is PACKED; its cartons' contents change only while it is a DRAFT")).toMatchObject({ path: 'packing/NOT_DRAFT' })
    expect(databasePackingRefusal('packing: TRUNCATE on "ParcelLine" is refused')).toMatchObject({ path: 'packing/REFUSED', message: 'The packing rules refuse this change.' })
    expect(databasePackingRefusal('carriers: shipment x has a tracking number typed by hand')).toBeNull()
  })
})
