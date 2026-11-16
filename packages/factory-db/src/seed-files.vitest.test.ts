import { createHash, randomUUID } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { seedFile, seedFileBytes, seedFileKey, seedFileKeyProblem, seedFileSha256, type SeedFileFacts } from './seed-files'

/**
 * The seeded files' bytes and keys (B-W2b-F59), pure: every content type a seed uses gets a small valid file of that type,
 * exactly the row's size, the same bytes every time; a key is checked against the files platform's own rule.
 */

const TENANT = '3e8ca154-711d-8707-a6a0-3b0995460ad4'
const COMPANY = 'e3ad7a90-a8ef-8c7d-a94c-e5abf1e85fb2'
const facts = (contentType: string, sizeBytes: number, originalName = 'Seed file (è made-up).bin'): SeedFileFacts => ({ id: '00000000-0000-8000-8000-000000000001', originalName, contentType, sizeBytes })
const crc32 = (data: Buffer): number => {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

describe('seedFileBytes: a valid file of the row’s type, exactly its size', () => {
  it('makes a PNG whose chunks are whole, with good CRCs, a 64 × 64 one-colour image and the name in a text chunk', () => {
    const body = seedFileBytes(facts('image/png', 4096, 'Seed brand P1 logo.png'))
    expect(body.length).toBe(4096)
    expect(body.subarray(0, 8).toString('latin1')).toBe('\x89PNG\r\n\x1a\n')
    const chunks: string[] = []
    for (let at = 8; at < body.length; ) {
      const length = body.readUInt32BE(at)
      const type = body.subarray(at + 4, at + 8).toString('latin1')
      expect(body.readUInt32BE(at + 8 + length), type).toBe(crc32(body.subarray(at + 4, at + 8 + length)))
      if (type === 'IHDR') expect([body.readUInt32BE(at + 8), body.readUInt32BE(at + 12)]).toEqual([64, 64])
      if (type === 'IDAT') expect(inflateSync(body.subarray(at + 8, at + 8 + length)).length).toBe(64 * 9)
      if (type === 'tEXt') expect(body.subarray(at + 8, at + 8 + length).toString('latin1')).toMatch(/^Comment\0seed file /)
      chunks.push(type)
      at += 12 + length
    }
    expect(chunks).toEqual(['IHDR', 'PLTE', 'tEXt', 'IDAT', 'IEND'])
  })

  it('makes a baseline JPEG: start marker, the JFIF segment first, COM segments, the picture and its end marker', () => {
    const body = seedFileBytes(facts('image/jpeg', 6144, 'Seed sample jacket front.jpg'))
    expect(body.length).toBe(6144)
    expect([body[0], body[1], body[2], body[3]]).toEqual([0xff, 0xd8, 0xff, 0xe0])
    expect(body.subarray(6, 10).toString('latin1')).toBe('JFIF')
    expect([body.at(-2), body.at(-1)]).toEqual([0xff, 0xd9])
    const markers: number[] = []
    for (let at = 2; body[at + 1] !== 0xda; at += 2 + body.readUInt16BE(at + 2)) markers.push(body[at + 1]!)
    expect(markers[0]).toBe(0xe0)
    expect(markers).toContain(0xfe)
    expect(markers).toContain(0xc0)
  })

  it('makes a PDF whose cross-reference table points at each object, padded in comments, with the name on its page', () => {
    for (const size of [1024, 2048, 4096, 20480, 20 * 1_048_576]) {
      const body = seedFileBytes(facts('application/pdf', size, 'Seed SDS A1:glue:v3.1:it.pdf'))
      expect(body.length).toBe(size)
      const text = body.toString('latin1')
      expect(text.startsWith('%PDF-1.4\n')).toBe(true)
      expect(text.endsWith('%%EOF\n')).toBe(true)
      const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1])
      expect(text.slice(startxref, startxref + 4)).toBe('xref')
      const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]))
      expect(offsets).toHaveLength(6)
      offsets.forEach((offset, index) => expect(text.slice(offset, offset + 8)).toBe(`${index + 1} 0 obj\n`))
      expect(text).toContain('(Seed SDS A1:glue:v3.1:it.pdf) Tj')
    }
  })

  it('makes an MP4 of whole boxes and a WebM whose Segment holds everything after its size', () => {
    const mp4 = seedFileBytes(facts('video/mp4', 4096))
    expect(mp4.length).toBe(4096)
    const boxes: string[] = []
    for (let at = 0; at < mp4.length; at += mp4.readUInt32BE(at)) boxes.push(mp4.subarray(at + 4, at + 8).toString('latin1'))
    expect(boxes).toEqual(['ftyp', 'moov', 'free', 'mdat', 'free'])
    const webm = seedFileBytes(facts('audio/webm', 4096))
    expect(webm.length).toBe(4096)
    expect(webm.readUInt32BE(0)).toBe(0x1a45dfa3)
    const segment = webm.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67]))
    expect(Number(webm.readBigUInt64BE(segment + 4) & 0x00ff_ffff_ffff_ffffn)).toBe(webm.length - segment - 12)
  })

  it('makes a ZIP with one stored README.txt (its CRC right), and well-formed text files', () => {
    const zip = seedFileBytes(facts('application/zip', 4096, 'SEED-EP-0002.zip'))
    expect(zip.length).toBe(4096)
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    const end = zip.length - 22
    expect(zip.readUInt32LE(end)).toBe(0x06054b50)
    const dataLength = zip.readUInt32LE(18)
    const data = zip.subarray(30 + 10, 30 + 10 + dataLength)
    expect(zip.readUInt32LE(14)).toBe(crc32(data))
    expect(data.toString('latin1')).toMatch(/^SEED-EP-0002\.zip\nMade-up seed file/)
    expect(zip.readUInt32LE(zip.readUInt32LE(end + 16))).toBe(0x02014b50)
    const xml = seedFileBytes(facts('application/xml', 1024, 'IT00000002022_00412.xml')).toString('latin1')
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<!-- Made-up seed file/)
    expect(xml).toContain('<SeedFile name="IT00000002022_00412.xml"')
    expect(seedFileBytes(facts('text/csv', 256, 'Seed widgets.csv')).toString('latin1')).toMatch(/^file;note\r\n"Seed widgets\.csv";"Made-up seed file [^"]*"\r\n$/)
    expect(seedFileBytes(facts('application/dxf', 4096)).toString('latin1')).toMatch(/\n0\nEOF\n$/)
    expect(seedFileBytes(facts('application/octet-stream', 4096)).toString('latin1')).toMatch(/^Seed file \(e made-up\)\.bin\nMade-up seed file/)
  })

  it('gives the same bytes for the same row and other bytes for another row; refuses a size too small for the type', () => {
    const one = facts('application/pdf', 2048)
    expect(seedFileBytes(one).equals(seedFileBytes({ ...one }))).toBe(true)
    expect(seedFileSha256(one)).toBe(createHash('sha256').update(seedFileBytes(one)).digest('hex'))
    expect(seedFileSha256({ ...one, id: randomUUID() })).not.toBe(seedFileSha256(one))
    expect(() => seedFileBytes(facts('application/pdf', 300))).toThrow(/300 bytes cannot hold a valid application\/pdf file; it needs at least \d+/)
  })
})

describe('the seeded files’ keys follow the files platform’s rule', () => {
  const at = new Date('2026-10-28T08:00:00.000Z')
  const random = '25ce6eba-907d-8464-9f5a-0fec78359cde'
  const row = (storageKey: string, kind = 'DOCUMENT', companyId: string | null = COMPANY) => ({ id: random, companyId, kind, storageKey, createdAt: at })
  it('accepts the key an upload makes for the row, under legal/ exactly for the fiscal archive', () => {
    expect(seedFileKey({ tenantId: TENANT, companyId: COMPANY, kind: 'DOCUMENT', at, random })).toBe(`t/${TENANT}/c/${COMPANY}/2026/${random}`)
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/c/${COMPANY}/2026/${random}`))).toBeNull()
    expect(seedFileKeyProblem(TENANT, row(`legal/t/${TENANT}/c/${COMPANY}/2026/${random}`, 'FISCAL_ARCHIVE'))).toBeNull()
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/tenant/2026/${random}`, 'PHOTO', null))).toBeNull()
  })
  it('names a key no upload could make: a stray folder, another year, company or tenant, the legal store for the wrong kind', () => {
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/c/${COMPANY}/health/${random}`))).toMatch(/is not a key the files platform makes/)
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/c/${COMPANY}/2025/${random}`))).toMatch(/is not the key an upload makes for it/)
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/tenant/2026/${random}`))).toMatch(/is not the key an upload makes for it/)
    expect(seedFileKeyProblem(TENANT, row(`t/${COMPANY}/c/${COMPANY}/2026/${random}`))).toMatch(/is not the key an upload makes for it/)
    expect(seedFileKeyProblem(TENANT, row(`legal/t/${TENANT}/c/${COMPANY}/2026/${random}`))).toMatch(/is not the key an upload makes for it/)
    expect(seedFileKeyProblem(TENANT, row(`t/${TENANT}/c/${COMPANY}/2026/${random}`, 'FISCAL_ARCHIVE'))).toMatch(/is not the key an upload makes for it/)
  })
  it('seedFile adds the hash of the bytes, takes the key year from createdAt, and refuses a row whose key breaks the rule otherwise', () => {
    const base = { id: random, companyId: COMPANY, recordType: 'Company', recordId: COMPANY, kind: 'DOCUMENT' as const, originalName: 'Seed cost sheet.pdf', contentType: 'application/pdf', sizeBytes: 2048, storeAccountId: random, createdAt: at }
    expect(seedFile(TENANT, { ...base, storageKey: `t/${TENANT}/c/${COMPANY}/2026/${random}` }).sha256).toBe(seedFileSha256(base))
    expect(() => seedFile(TENANT, { ...base, storageKey: `t/${TENANT}/c/${COMPANY}/safety/${random}` })).toThrow(/is not a key the files platform makes/)
    // A row dated in the seeds' moving future (seedAt) may fall in the next year: the key takes the year of its createdAt.
    const later = seedFile(TENANT, { ...base, createdAt: new Date('2027-01-12T09:00:00.000Z'), storageKey: `t/${TENANT}/c/${COMPANY}/2026/${random}` })
    expect(later.storageKey).toBe(`t/${TENANT}/c/${COMPANY}/2027/${random}`)
    expect(() => seedFile(TENANT, { ...base, storageKey: `t/${TENANT}/tenant/2026/${random}` })).toThrow(/is not the key an upload makes for it/)
    const source = { ...base, id: randomUUID(), originalName: 'Seed certificate.pdf' }
    expect(seedFile(TENANT, { ...base, storageKey: `t/${TENANT}/c/${COMPANY}/2026/${random}` }, { bytesOf: source }).sha256).toBe(seedFileSha256(source))
  })
})
