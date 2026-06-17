/**
 * FX.2 — external-file parsers behind POST /api/amazon/flat-file/parse.
 * The new tab-delimiter support + the comma/tab sniff + the xlsx bytes path
 * (the three things the endpoint relies on) are pure/round-trippable, so they
 * unit-test without booting Fastify.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseCsv, parseJson, parseXlsx, sniffDelimiter, detectFileKind } from './parsers.js'

describe('FX.2 — parseCsv delimiter', () => {
  it('defaults to comma (existing callers unchanged)', () => {
    const { headers, rows } = parseCsv('SKU,Title\nA1,Jacket')
    expect(headers).toEqual(['SKU', 'Title'])
    expect(rows).toEqual([{ SKU: 'A1', Title: 'Jacket' }])
  })
  it('parses tab-separated when delimiter is a tab', () => {
    const { headers, rows } = parseCsv('SKU\tTitle\nA1\tJacket', '\t')
    expect(headers).toEqual(['SKU', 'Title'])
    expect(rows).toEqual([{ SKU: 'A1', Title: 'Jacket' }])
  })
  it('a comma-containing value is one cell under tab delimiter', () => {
    const { rows } = parseCsv('SKU\tName\nA1\tGloves, leather', '\t')
    expect(rows[0].Name).toBe('Gloves, leather')
  })
})

describe('FX.2 — sniffDelimiter', () => {
  it('.tsv / .tab filename → tab', () => {
    expect(sniffDelimiter('supplier.tsv', 'a\tb')).toBe('\t')
    expect(sniffDelimiter('supplier.tab', 'a\tb')).toBe('\t')
  })
  it('.csv filename → comma even if the line has tabs', () => {
    expect(sniffDelimiter('supplier.csv', 'a,b\tc')).toBe(',')
  })
  it('no decisive extension → sniff the first non-empty line', () => {
    expect(sniffDelimiter('data.txt', '\n\nSKU\tTitle\tPrice')).toBe('\t')
    expect(sniffDelimiter('data.txt', 'SKU,Title,Price')).toBe(',')
    expect(sniffDelimiter(undefined, 'SKU\tTitle')).toBe('\t')
  })
})

describe('FX.2 — detectFileKind drives the parse branch', () => {
  it('maps extensions to parse families (.tsv/.txt fall to the csv/text branch)', () => {
    expect(detectFileKind('a.xlsx')).toBe('xlsx')
    expect(detectFileKind('a.json')).toBe('json')
    expect(detectFileKind('a.csv')).toBe('csv')
    expect(detectFileKind('a.tsv')).toBe('csv')
    expect(detectFileKind('a.txt')).toBe('csv')
  })
})

describe('FX.2 — parseXlsx bytes round-trip (the endpoint base64 path)', () => {
  it('reads headers + rows back from a workbook buffer', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.addRow(['SKU', 'Title', 'Price'])
    ws.addRow(['A1', 'Jacket', 129.9])
    ws.addRow(['A2', 'Pants', 89])
    const buf = await wb.xlsx.writeBuffer()
    const { headers, rows } = await parseXlsx(new Uint8Array(buf as ArrayBuffer))
    expect(headers).toEqual(['SKU', 'Title', 'Price'])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ SKU: 'A1', Title: 'Jacket' })
    expect(rows[1]).toMatchObject({ SKU: 'A2', Title: 'Pants' })
  })
})

describe('FX.2 — parseJson array of objects', () => {
  it('unions keys as headers and fills missing with empty', () => {
    const { headers, rows } = parseJson('[{"SKU":"A1","Title":"Jacket"},{"SKU":"A2","Color":"Red"}]')
    expect(headers).toEqual(['SKU', 'Title', 'Color'])
    expect(rows).toEqual([
      { SKU: 'A1', Title: 'Jacket', Color: '' },
      { SKU: 'A2', Title: '', Color: 'Red' },
    ])
  })
})
