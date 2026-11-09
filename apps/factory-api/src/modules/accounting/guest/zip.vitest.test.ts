import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { zipEntries } from '../../../platform/imports/sheet'
import { crc32, indexCsv, writeZip } from './zip'

/** Reads a zip written by writeZip back (local headers in order): path, method and the bytes, checked by CRC. */
function readBack(zip: Buffer): { path: string; method: number; bytes: Buffer }[] {
  const out: { path: string; method: number; bytes: Buffer }[] = []
  let at = 0
  while (zip.readUInt32LE(at) === 0x04034b50) {
    const flags = zip.readUInt16LE(at + 6)
    const method = zip.readUInt16LE(at + 8)
    const crc = zip.readUInt32LE(at + 14)
    const packed = zip.readUInt32LE(at + 18)
    const size = zip.readUInt32LE(at + 22)
    const nameLength = zip.readUInt16LE(at + 26)
    const extra = zip.readUInt16LE(at + 28)
    expect(flags & 0x0800).toBe(0x0800)
    const path = zip.subarray(at + 30, at + 30 + nameLength).toString('utf8')
    const data = zip.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + packed)
    const bytes = method === 8 ? inflateRawSync(data) : Buffer.from(data)
    expect(bytes.length).toBe(size)
    expect(crc32(bytes)).toBe(crc)
    out.push({ path, method, bytes })
    at += 30 + nameLength + extra + packed
  }
  return out
}

describe('the accountant’s zip (B-W2b-201)', () => {
  it('knows the CRC-32 of the standard check value', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('writes entries that read back byte for byte, deflated when smaller, with UTF-8 names and a central directory', () => {
    const xml = Buffer.from(`<?xml version="1.0"?><FatturaElettronica>${'<Riga>esempio</Riga>'.repeat(200)}</FatturaElettronica>`)
    const random = Buffer.from(Array.from({ length: 64 }, (_, index) => (index * 97 + 13) % 251))
    const zip = writeZip(
      [
        { path: 'index.csv', bytes: indexCsv([{ path: 'e-invoices/sales/IT0_00001.xml', what: 'SALES_XML', number: 'FT-2026-00001', date: '2026-10-28', sha256: 'ab', sizeBytes: xml.length, included: true }]) },
        { path: 'e-invoices/sales/IT0_00001.xml', bytes: xml },
        { path: 'registers/città.bin', bytes: random },
      ],
      new Date('2026-11-09T10:15:30.000Z'),
    )
    const entries = readBack(zip)
    expect(entries.map((entry) => entry.path)).toEqual(['index.csv', 'e-invoices/sales/IT0_00001.xml', 'registers/città.bin'])
    expect(entries[1]!.method).toBe(8)
    expect(entries[1]!.bytes.equals(xml)).toBe(true)
    expect(entries[2]!.method).toBe(0)
    expect(entries[2]!.bytes.equals(random)).toBe(true)
    expect(entries[0]!.bytes.toString('utf8')).toContain('e-invoices/sales/IT0_00001.xml,SALES_XML,FT-2026-00001,2026-10-28,ab,')
    // The central directory the import code reads (and every zip tool): the same three entries.
    expect(zipEntries(zip)?.map((entry) => entry.name)).toEqual(['index.csv', 'e-invoices/sales/IT0_00001.xml', 'registers/città.bin'])
  })

  it('writes an empty zip that is still a zip', () => {
    const zip = writeZip([], new Date('2026-11-09T10:00:00.000Z'))
    expect(zip.length).toBe(22)
    expect(zip.readUInt32LE(0)).toBe(0x06054b50)
  })
})
