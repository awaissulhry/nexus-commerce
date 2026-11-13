import { describe, expect, it } from 'vitest'
import { cartonMarks } from '@nexus/factory-domain/shipping/cartons/marks'
import { marksHeightMm, marksPdf, marksStockProblems, marksZpl } from './shipping-marks'

const marks = cartonMarks(['SHIP_TO', 'CUSTOMER_ORDER', 'CARTON_NUMBER', 'SIZES', 'QUANTITY'], 'en', {
  maker: 'Demo Pelle',
  sender: null,
  shipTo: { name: 'Demo Brand ^XA', line1: 'Weg 2', postalCode: '10115', city: 'Berlin', country: 'DE' },
  customerOrder: 'PO-778',
  orderNumber: 'SO-0042',
  shipmentNumber: 'SH-00012',
  cartonNumber: 1,
  cartonCount: 2,
  contents: [{ styleCode: 'JKT-01', styleName: 'Jacket', colourwayCode: 'BLK', colourwayName: 'Black', size: '52', quantity: 3, batchNumber: 'BT-41', originCountry: 'IT' }],
  grossWeightKg: null,
  netWeightKg: null,
  dimensionsCm: null,
})

describe("a carton's shipping marks laid out (B-W2b-384; LOG-013)", () => {
  it('needs a label as tall as its rows; a smaller stock is refused in words', () => {
    const height = marksHeightMm(marks)
    expect(height).toBeGreaterThan(48)
    expect(marksStockProblems(marks, { dpi: 203, widthMm: 100, heightMm: 150 })).toEqual([])
    expect(marksStockProblems(marks, { dpi: 203, widthMm: 100, heightMm: height - 1 })[0]?.message).toMatch(new RegExp(`at least 76 mm wide and ${height} mm high`))
  })

  it('makes ZPL with the code as Code 128 and every value escaped (a value never starts a ZPL command)', () => {
    const zpl = marksZpl(marks, { dpi: 203, widthMm: 100, heightMm: 150 }, 2)
    expect(zpl.startsWith('^XA\n^CI28')).toBe(true)
    expect(zpl).toContain('^BCN')
    expect(zpl).toContain('^FDSH-00012-1^FS')
    expect(zpl).toContain('Carton 1 of 2')
    expect(zpl).toContain('Demo Brand _5EXA')
    expect(zpl).not.toContain('Demo Brand ^XA')
    expect(zpl).toContain('^PQ2')
    expect(() => marksZpl(marks, { dpi: 203, widthMm: 100, heightMm: 40 })).toThrow(RangeError)
  })

  it('makes a PDF page per copy', async () => {
    const pdf = await marksPdf([marks, marks], 1)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(2)
  })
})
