import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { decodeCsv, detectDelimiter, excelCell, readSheet, SheetError, workbookProblem, zipEntries } from './sheet'

// The sheet reader on made-up sheets built in memory: CSV in both encodings and delimiters, Excel workbooks with
// formulas, dates, errors and several sheets, and the refusals (macros, a zip bomb, too many rows, not a sheet).

const csv = (text: string, encoding: 'utf-8' | 'windows-1252' = 'utf-8'): Buffer =>
  encoding === 'utf-8' ? Buffer.from(text, 'utf8') : Buffer.from([...text].map((char) => (char === 'à' ? 0xe0 : char === '€' ? 0x80 : char === 'è' ? 0xe8 : char.charCodeAt(0))))
const CSV = { contentType: SHEET_TYPES.csv, maxRows: 100 }
const XLSX = { contentType: SHEET_TYPES.xlsx, maxRows: 100 }

async function workbook(build: (book: ExcelJS.Workbook) => void): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  build(book)
  return Buffer.from(await book.xlsx.writeBuffer())
}

/** A zip with stored entries; `claimed` overrides the unpacked size its directory states. */
function zip(entries: { name: string; body: Buffer; claimed?: number }[]): Buffer {
  const parts: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(entry.body.length, 18)
    local.writeUInt32LE(entry.claimed ?? entry.body.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, entry.body)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(entry.body.length, 20)
    central.writeUInt32LE(entry.claimed ?? entry.body.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)
    offset += 30 + name.length + entry.body.length
  }
  const listing = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(listing.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, listing, end])
}

const refusal = async (work: Promise<unknown>): Promise<string> => {
  const error = await work.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(SheetError)
  return (error as SheetError).issues.map((issue) => issue.message).join(' ')
}

describe('CSV', () => {
  it('reads an Italian Excel CSV: semicolons, a BOM, quotes, blank rows skipped, row numbers kept', async () => {
    const text = '﻿Codice;Descrizione;Prezzo\r\nA-1;"Giacca; nera";1.234,50\r\n;;\r\nB-2;"Riga ""due""\ncon a capo";7\r\n'
    const sheet = await readSheet(csv(text), CSV)
    expect(sheet).toMatchObject({ format: 'csv', encoding: 'utf-8', delimiter: ';', headers: ['Codice', 'Descrizione', 'Prezzo'] })
    expect(sheet.rows).toEqual([
      { rowNumber: 2, cells: ['A-1', 'Giacca; nera', '1.234,50'] },
      { rowNumber: 4, cells: ['B-2', 'Riga "due"\ncon a capo', '7'] },
    ])
  })

  it('reads Windows-1252 when the bytes are not UTF-8, or when asked', async () => {
    const latin = csv('nome,città\nCaffè,Forlì\n', 'windows-1252')
    expect(decodeCsv(latin, null)).toMatchObject({ encoding: 'windows-1252' })
    const sheet = await readSheet(latin, CSV)
    expect(sheet.headers).toEqual(['nome', 'città'])
    expect(sheet.rows[0]!.cells).toEqual(['Caffè', 'Forlì'])
    expect(decodeCsv(Buffer.from('prezzo\n€ 5\n', 'utf8'), 'windows-1252').text).not.toContain('€')
    expect(await refusal(readSheet(latin, { ...CSV, encoding: 'utf-8' }))).toMatch(/not valid UTF-8/)
  })

  it('finds the delimiter from the header line', () => {
    expect(detectDelimiter('a;b;c\n1,5;2;3')).toBe(';')
    expect(detectDelimiter('a,b,c\n1;2')).toBe(',')
    expect(detectDelimiter('a\tb\n')).toBe('\t')
    expect(detectDelimiter('"a;b",c\n')).toBe(',')
  })

  it('refuses an empty sheet, a sheet without data, too many rows, and broken quotes (naming the line, not the value)', async () => {
    expect(await refusal(readSheet(csv('\n\n'), CSV))).toMatch(/empty/)
    expect(await refusal(readSheet(csv('code,name\n'), CSV))).toMatch(/no rows of data/)
    const many = ['code', ...Array.from({ length: 101 }, (_, index) => `C${index}`)].join('\n')
    expect(await refusal(readSheet(csv(many), CSV))).toMatch(/101 rows of data; this import takes at most 100/)
    const broken = await refusal(readSheet(csv('code,name\nA,"secret value\n'), CSV))
    expect(broken).toMatch(/not valid/)
    expect(broken).not.toContain('secret')
  })
})

describe('Excel', () => {
  it('reads the first sheet: formulas as their values, dates, rich text, errors as unreadable cells', async () => {
    const bytes = await workbook((book) => {
      const sheet = book.addWorksheet('Articoli')
      sheet.addRow(['Codice', 'Quantità', 'Prezzo', 'Data', 'Note'])
      sheet.addRow(['A-1', 4, { formula: 'B2*2.5', result: 10 }, new Date(Date.UTC(2026, 11, 31)), { richText: [{ text: 'Rosso ' }, { text: 'scuro' }] }])
      sheet.addRow([])
      sheet.addRow(['B-2', { formula: '1/0', result: { error: '#DIV/0!' } }, 1234.5, null, { error: '#N/A' }])
      book.addWorksheet('Altro').addRow(['x'])
    })
    const sheet = await readSheet(bytes, XLSX)
    expect(sheet).toMatchObject({ format: 'xlsx', sheet: 'Articoli', sheets: ['Articoli', 'Altro'], headers: ['Codice', 'Quantità', 'Prezzo', 'Data', 'Note'] })
    expect(sheet.rows[0]).toEqual({ rowNumber: 2, cells: ['A-1', 4, 10, new Date(Date.UTC(2026, 11, 31)), 'Rosso scuro'] })
    expect(sheet.rows[1]!.rowNumber).toBe(4)
    expect(sheet.rows[1]!.cells[1]).toBeNaN()
    expect(sheet.rows[1]!.cells[4]).toBeNaN()
  })

  it('reads a named sheet without case or accents, and lists the sheets when it is missing', async () => {
    const bytes = await workbook((book) => {
      book.addWorksheet('Note').addRow(['ignore me'])
      const prices = book.addWorksheet('Prezzi Unità')
      prices.addRow(['code', 'price'])
      prices.addRow(['A', 1])
    })
    expect((await readSheet(bytes, { ...XLSX, sheetName: 'prezzi unita' })).rows).toEqual([{ rowNumber: 2, cells: ['A', 1] }])
    expect(await refusal(readSheet(bytes, { ...XLSX, sheetName: 'Listino' }))).toBe('The workbook has no sheet named "Listino"; its sheets are "Note", "Prezzi Unità".')
  })

  it('refuses macros, a zip bomb, and a file that is not a workbook, before opening it', async () => {
    const real = await workbook((book) => book.addWorksheet('A').addRow(['code']))
    expect(workbookProblem(real)).toBeNull()
    expect(zipEntries(real)!.some((entry) => entry.name === 'xl/workbook.xml')).toBe(true)
    const macros = zip([{ name: '[Content_Types].xml', body: Buffer.from('<Types/>') }, { name: 'xl/vbaProject.bin', body: Buffer.from('made-up') }])
    expect(await refusal(readSheet(macros, XLSX))).toMatch(/contains macros/)
    const bomb = zip([{ name: 'xl/worksheets/sheet1.xml', body: Buffer.from('<x/>'), claimed: 200 * 1_048_576 }])
    expect(await refusal(readSheet(bomb, XLSX))).toMatch(/too large once unpacked/)
    expect(await refusal(readSheet(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]), XLSX))).toMatch(/not a valid Excel workbook/)
    expect(await refusal(readSheet(zip([{ name: 'a.txt', body: Buffer.from('a') }]), XLSX))).toMatch(/not a valid Excel workbook/)
  })

  it('maps Excel cell values', () => {
    expect(excelCell({ text: 'link', hyperlink: 'https://example.com' })).toBe('link')
    expect(excelCell({ sharedFormula: 'A1', result: 'x' } as never)).toBe('x')
    expect(excelCell(undefined)).toBeNull()
  })
})
