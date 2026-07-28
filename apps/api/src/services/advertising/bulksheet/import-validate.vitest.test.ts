/**
 * AX-IE.4 — upload guards and addressing.
 *
 * These cover the checks that run BEFORE any decompression is pointed at an
 * uploaded file, plus the cell addressing that makes an error message something
 * an operator can navigate to rather than just read.
 */
import { describe, it, expect } from 'vitest'
import { looksLikeXlsx, assertNotZipBomb, columnLetter, MAX_ISSUES, MAX_ROWS } from './import-validate.js'
import { isExcelJsStreamOrderingBug } from './spreadsheet-adapter.js'

/** Minimal but structurally valid ZIP: one stored entry, real EOCD. */
function makeZip(entries: Array<{ name: string; uncompressed: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'ascii')
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt32LE(e.uncompressed, 18) // compressed
    local.writeUInt32LE(e.uncompressed, 22) // uncompressed
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt32LE(e.uncompressed, 20) // compressed
    central.writeUInt32LE(e.uncompressed, 24) // uncompressed
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length
  }
  const localBuf = Buffer.concat(locals)
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(localBuf.length, 16)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

describe('magic-byte sniff', () => {
  it('accepts a ZIP header and rejects anything else', () => {
    // Filename and browser-supplied MIME are both attacker-controlled; the bytes are not.
    expect(looksLikeXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))).toBe(true)
    expect(looksLikeXlsx(Buffer.from('this is not a spreadsheet'))).toBe(false)
    expect(looksLikeXlsx(Buffer.from('%PDF-1.7'))).toBe(false)
    expect(looksLikeXlsx(Buffer.alloc(0))).toBe(false)
  })
})

describe('zip-bomb defence', () => {
  it('accepts an ordinary workbook', () => {
    const zip = makeZip([
      { name: 'xl/workbook.xml', uncompressed: 2_000 },
      { name: 'xl/worksheets/sheet1.xml', uncompressed: 900_000 },
    ])
    const r = assertNotZipBomb(zip)
    expect(r.entries).toBe(2)
    expect(r.uncompressed).toBe(902_000)
  })

  it('refuses on total uncompressed size — the upload cap only bounds COMPRESSED bytes', () => {
    const zip = makeZip([{ name: 'a.xml', uncompressed: 900 * 1024 * 1024 }])
    expect(() => assertNotZipBomb(zip)).toThrow(/expands to more than/)
  })

  it('refuses on entry count', () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ name: `f${i}.xml`, uncompressed: 10 }))
    expect(() => assertNotZipBomb(makeZip(many))).toThrow(/internal entries/)
  })

  it('refuses a truncated or non-ZIP payload rather than handing it to a parser', () => {
    expect(() => assertNotZipBomb(Buffer.from('not a zip at all'))).toThrow(/ZIP directory is missing/)
  })

  it('honours caller-supplied limits', () => {
    const zip = makeZip([{ name: 'a.xml', uncompressed: 5_000_000 }])
    expect(() => assertNotZipBomb(zip, { maxUncompressed: 1_000_000 })).toThrow(/expands to more than/)
    expect(assertNotZipBomb(zip, { maxUncompressed: 10_000_000 }).uncompressed).toBe(5_000_000)
  })
})

describe('cell addressing', () => {
  it('maps column indexes to spreadsheet letters, including past Z', () => {
    expect(columnLetter(0)).toBe('A')
    expect(columnLetter(19)).toBe('T') // Bid, in the current layout
    expect(columnLetter(25)).toBe('Z')
    expect(columnLetter(26)).toBe('AA')
    expect(columnLetter(51)).toBe('AZ')
    expect(columnLetter(52)).toBe('BA')
  })
})

describe('ExcelJS streaming-reader ordering bug', () => {
  it('is recognised so the caller can fall back instead of failing the upload', () => {
    // workbook-reader.js:303 reads this.model.sheets while guarding
    // this.workbookRels on the line above — reproduced with a plain 2-row workbook.
    expect(isExcelJsStreamOrderingBug(new TypeError("Cannot read properties of undefined (reading 'sheets')"))).toBe(true)
    expect(isExcelJsStreamOrderingBug(new TypeError("Cannot read property 'sheets' of undefined"))).toBe(true)
    expect(isExcelJsStreamOrderingBug(new Error('ENOENT: no such file'))).toBe(false)
  })
})

describe('documented caps', () => {
  it('are the ones the README and the error messages promise', () => {
    expect(MAX_ROWS).toBe(100_000)
    expect(MAX_ISSUES).toBe(5_000)
  })
})
