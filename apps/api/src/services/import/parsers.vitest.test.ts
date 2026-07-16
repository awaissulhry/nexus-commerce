/**
 * FX.2 — external-file parsers behind POST /api/amazon/flat-file/parse.
 * The new tab-delimiter support + the comma/tab sniff + the xlsx bytes path
 * (the three things the endpoint relies on) are pure/round-trippable, so they
 * unit-test without booting Fastify.
 */
import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { parseCsv, parseJson, parseXlsx, sniffDelimiter, sniffDelimiterSmart, detectFileKind, sniffExcelContainer } from './parsers.js'

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

describe('IM.2 — sniffDelimiterSmart (content-first, never trusts .csv)', () => {
  it('semicolon CSV under a .csv extension (Italian Excel) → semicolon', () => {
    expect(sniffDelimiterSmart('magazzino.csv', 'sku;qta;note\nGAL-1;5;ok\nGAL-2;3;')).toBe(';')
  })
  it('plain comma CSV stays comma', () => {
    expect(sniffDelimiterSmart('stock.csv', 'sku,qty\nA,1\nB,2')).toBe(',')
  })
  it('pasted Excel cells (tabs, no meaningful extension) → tab', () => {
    expect(sniffDelimiterSmart('pasted.txt', 'sku\tqty\nA\t1')).toBe('\t')
  })
  it('.tsv extension still forces tab', () => {
    expect(sniffDelimiterSmart('x.tsv', 'a;b')).toBe('\t')
  })
  it('quoted commas inside semicolon fields do not fool the sniff', () => {
    expect(sniffDelimiterSmart('x.csv', '"Giacca, nera";qty\n"Guanti, pelle";2')).toBe(';')
  })
  it('comma delimiter wins when data rows have consistent comma counts but stray semicolons', () => {
    expect(sniffDelimiterSmart('x.csv', 'sku,note\nA,ciao;mondo\nB,ok')).toBe(',')
  })
  it('pipe-separated files sniff to pipe', () => {
    expect(sniffDelimiterSmart('x.txt', 'sku|qty\nA|1\nB|2')).toBe('|')
  })
  it('single-column file defaults to comma', () => {
    expect(sniffDelimiterSmart('x.csv', 'sku\nA\nB')).toBe(',')
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

describe('A1 (XLSM hybrid) — .xlsm/.xlsb kinds + container sniffing', () => {
  it('detectFileKind maps .xlsm and .xlsb into the xlsx family', () => {
    expect(detectFileKind('AIREON IT.xlsm')).toBe('xlsx')
    expect(detectFileKind('workbook.XLSB')).toBe('xlsx')
    expect(detectFileKind('legacy.xls')).toBe('xlsx')
  })

  it('sniffExcelContainer recognizes OOXML zips, BIFF, and neither', async () => {
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('S').addRow(['a'])
    const ooxml = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    expect(sniffExcelContainer(ooxml)).toBe('ooxml')
    expect(sniffExcelContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]))).toBe('biff')
    expect(sniffExcelContainer(new TextEncoder().encode('SKU,Title\n1,2'))).toBe('unknown')
  })

  it('parseXlsx accepts an OOXML buffer regardless of the .xlsm name (bytes win)', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Sheet1')
    ws.addRow(['SKU', 'Qty'])
    ws.addRow(['A1', 5])
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer)
    const { headers, rows } = await parseXlsx(bytes)
    expect(headers).toEqual(['SKU', 'Qty'])
    expect(rows).toHaveLength(1)
  })

  it('parseXlsx rejects legacy BIFF .xls with a re-save hint', async () => {
    const biff = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])
    await expect(parseXlsx(biff)).rejects.toThrow(/save it as \.xlsx or \.xlsm/)
  })

  it('parseXlsx rejects non-Excel bytes with a clear message', async () => {
    const text = new TextEncoder().encode('this is not an excel file')
    await expect(parseXlsx(text)).rejects.toThrow(/Not a valid Excel workbook/)
  })
})
